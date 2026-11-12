import { BrowserWindow, dialog, safeStorage } from "electron";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { CompanyAccount, type AccountSnapshot } from "./account.js";
import { CompanyToapis } from "./toapis.js";
import type { CompanyDefaults } from "./defaults.js";
import {
  executionContext,
  executionSpace,
  setExecutionDetailsResolver,
  setSelectedSpaceResolver,
} from "../execution-space.js";
import { flushWindow } from "../window-lifecycle.js";
import type { EnterpriseClient } from "../enterprise/client.js";
import type { EnterpriseStatus, SpaceKind } from "../../shared/enterprise.js";
import type {
  AppSettings,
  TextProviderConfig,
  ProviderConfig,
} from "../../shared/types.js";
import type { AssetStore } from "../storage/asset-store.js";
import type { BoardStore } from "../storage/board-store.js";
import { ENTERPRISE_ASSET_PREFIX } from "../../shared/enterprise.js";

interface Preferences {
  version: 1;
  origin: string;
  activeSpace: SpaceKind;
  folders: Record<string, string>;
  selections: Record<string, { image?: string; text?: string }>;
  storage?: Record<string, { kind: "nas" | "local"; url?: string }>;
}
/** Coordinates app identity with separately selected business storage. */
export class CompanyDesktop {
  readonly account: CompanyAccount;
  readonly toapis: CompanyToapis;
  private preferences: Preferences;
  private savedFiles = new Set<string>();
  private writing = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private nasImageWritable = false;
  private imageRevision = "";
  private imageConfigured = false;
  private imageSetupError?: string;
  changingSpace = false;
  constructor(
    readonly userData: string,
    readonly legacy: EnterpriseClient,
    private readonly defaults: CompanyDefaults = {},
  ) {
    this.preferences = {
      version: 1,
      origin:
        process.env.TUDA_COMPANY_URL?.trim() || defaults.accountOrigin || "",
      activeSpace: "personal",
      folders: {},
      selections: {},
    };
    this.account = new CompanyAccount(
      this.preferences.origin,
      async (value) => {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统安全存储不可用，未保存公司登录凭据。");
        const encrypted = safeStorage
          .encryptString(JSON.stringify(value))
          .toString("base64");
        await this.write("company-session.json", { version: 1, encrypted });
      },
    );
    this.toapis = new CompanyToapis(
      path.join(userData, "company-models"),
      () => {
        this.assertAccount();
        const bootstrap = this.account.bootstrap;
        if (!bootstrap) throw new Error("请先刷新公司模型授权。");
        return { namespace: this.namespace!, image: bootstrap.image };
      },
      undefined,
      () => {
        if (
          executionSpace() === "enterprise" &&
          this.usesNas &&
          !this.legacy.status.connected
        )
          throw new Error("NAS 暂时不可用，请先选择公司本地文件夹后生成图片。");
        if (
          executionSpace() === "enterprise" &&
          this.usesNas &&
          !this.nasImageWritable
        )
          throw new Error(
            "当前 NAS 存储为只读；请切换个人空间或公司本地文件夹后生成图片。",
          );
      },
    );
    this.account.on("state", () => {
      this.changed();
      void this.prepareImage();
    });
    this.legacy.on("state", () => {
      if (this.enabled) this.changed();
    });
  }
  private async prepareImage() {
    const b = this.account.bootstrap;
    const revision =
      b?.image.enabled && this.namespace
        ? this.namespace + ":" + b.configVersion
        : "";
    if (revision === this.imageRevision) return;
    this.imageRevision = revision;
    this.imageConfigured = false;
    this.imageSetupError = undefined;
    if (!revision) {
      this.changed();
      return;
    }
    try {
      await this.toapis.testConnection();
      if (revision === this.imageRevision) this.imageConfigured = true;
    } catch {
      if (revision === this.imageRevision)
        this.imageSetupError =
          "ToAPIs 员工凭据验证失败，请刷新模型授权或联系管理员。";
    } finally {
      this.changed();
    }
  }
  get enabled() {
    return !!this.account.origin;
  }
  get activeSpace() {
    return this.enabled
      ? this.preferences.activeSpace
      : this.legacy.activeSpace;
  }
  get namespace() {
    const s = this.account.session;
    return s
      ? createHash("sha256")
          .update(
            JSON.stringify([
              this.account.origin,
              s.organization.id,
              s.member.id,
            ]),
          )
          .digest("hex")
      : undefined;
  }
  get folder() {
    return this.namespace
      ? this.preferences.folders[this.namespace]
      : undefined;
  }
  get storage() {
    return this.namespace
      ? (this.preferences.storage?.[this.namespace] ??
          (this.defaultNasUrl
            ? { kind: "nas" as const, url: this.defaultNasUrl }
            : undefined))
      : undefined;
  }
  private get defaultNasUrl() {
    return this.defaults.nasUrl || this.legacy.status.serverUrl;
  }
  get usesNas() {
    return this.enabled && this.storage?.kind === "nas";
  }
  get workspace() {
    return this.usesNas && this.namespace
      ? path.join(this.userData, "company-cache", this.namespace)
      : this.folder && this.namespace
        ? path.join(this.folder, ".tuda-company", this.namespace)
        : undefined;
  }
  get status(): EnterpriseStatus {
    if (!this.enabled) return this.legacy.status;
    const a = this.account.status;
    return {
      configured: true,
      serverUrl: this.account.origin,
      activeSpace: this.activeSpace,
      authenticated: a.authenticated,
      organizationName: a.organization?.name,
      user: a.member
        ? {
            ...a.member,
            role: this.usesNas
              ? (this.legacy.status.user?.role ?? "viewer")
              : "editor",
          }
        : undefined,
      connected: this.usesNas ? this.legacy.status.connected : !!this.workspace,
      pendingWrites: this.usesNas ? this.legacy.status.pendingWrites : 0,
      nasPendingWrites: this.legacy.status.pendingWrites,
      peers: this.usesNas ? this.legacy.status.peers : [],
      error:
        a.error ??
        this.imageSetupError ??
        (this.usesNas ? this.legacy.status.error : undefined),
      history: this.usesNas ? this.legacy.status.history : undefined,
      accountMode: "shared",
      storageKind: this.usesNas ? "nas" : "local",
      storageUrl: this.storage?.url ?? this.defaultNasUrl,
      localFolder: this.folder,
      textModels: a.textModels,
      imageModels: a.imageModels,
      imageConfigured: this.imageConfigured,
      imageReason: a.imageReason,
      configVersion: a.configVersion,
    };
  }
  private changed() {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send("enterprise:state", this.status);
  }
  private reload() {
    this.changed();
    const windows = BrowserWindow.getAllWindows().filter(
      (w) => !w.isDestroyed(),
    );
    if (!windows.length) this.changingSpace = false;
    setTimeout(() => {
      const remaining = new Set(windows);
      const done = (w: BrowserWindow) => {
        remaining.delete(w);
        if (!remaining.size) this.changingSpace = false;
      };
      for (const w of windows) {
        if (w.isDestroyed()) {
          done(w);
          continue;
        }
        w.webContents.once("did-finish-load", () => done(w));
        w.once("closed", () => done(w));
        w.webContents.reload();
      }
    }, 200);
  }
  async flush() {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed() && /^(https?:|file:)/.test(w.webContents.getURL()))
        await flushWindow(w);
  }
  private async write(name: string, value: unknown) {
    const work = this.writing.then(async () => {
      await mkdir(this.userData, { recursive: true, mode: 0o700 });
      const file = path.join(this.userData, name),
        existing = await stat(file).catch(() => null);
      if (existing && !this.savedFiles.has(file)) {
        await copyFile(file, file + ".backup-" + randomUUID());
        this.savedFiles.add(file);
      }
      const tmp = file + "." + randomUUID();
      await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      await rename(tmp, file);
    });
    this.writing = work.catch(() => undefined);
    return work;
  }
  private async save() {
    this.preferences.origin = this.account.origin;
    await this.write("company-workspaces.json", this.preferences);
  }
  async initialize() {
    try {
      const p = JSON.parse(
        await readFile(
          path.join(this.userData, "company-workspaces.json"),
          "utf8",
        ),
      );
      if (p.version !== 1 || !p.folders || !p.selections)
        throw new Error("公司空间配置版本无效。");
      this.preferences = p;
      await this.account.configure(p.origin, false);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (this.enabled) {
      this.legacy.stop();
      try {
        const p = JSON.parse(
          await readFile(
            path.join(this.userData, "company-session.json"),
            "utf8",
          ),
        );
        if (p.version !== 1 || !safeStorage.isEncryptionAvailable())
          throw new Error("无法解密公司会话。");
        await this.account.restore(
          JSON.parse(
            safeStorage.decryptString(Buffer.from(p.encrypted, "base64")),
          ) as AccountSnapshot,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn("公司登录需重新授权。");
      }
      if (this.account.authenticated)
        void this.account
          .refresh()
          .then(() => (this.usesNas ? this.connectNas() : undefined))
          .catch(() => undefined);
      else this.preferences.activeSpace = "personal";
    }
    setSelectedSpaceResolver(() => this.activeSpace);
    setExecutionDetailsResolver(() =>
      this.enabled
        ? {
            account: this.namespace,
            workspace: this.workspace,
            storage: this.storage,
          }
        : {},
    );
    this.refreshTimer = setInterval(() => {
      if (this.account.authenticated)
        void this.account.refresh().catch(() => undefined);
      this.changed();
    }, 15 * 60_000);
    this.refreshTimer.unref();
  }
  assertAccount() {
    const context = executionContext();
    if (
      !this.account.authenticated ||
      (context.account && context.account !== this.namespace)
    )
      throw new Error("公司登录已更改，请重新打开当前画板。");
  }
  async configure(origin: string) {
    await this.flush();
    this.changingSpace = true;
    await this.account.configure(origin);
    this.legacy.stop();
    this.preferences.activeSpace = "personal";
    await this.save();
    this.reload();
    return this.status;
  }
  async beginLogin() {
    if (this.enabled && this.account.authenticated)
      throw new Error("当前已登录公司账号，请先退出后切换账号。");
    return this.enabled ? this.account.beginLogin() : this.legacy.beginLogin();
  }
  async pollLogin() {
    if (!this.enabled) return this.legacy.pollLogin();
    const result = await this.account.pollLogin();
    if (result.status === "authorized") {
      await this.flush();
      if (!this.workspace) await this.chooseFolder(false);
      if (this.usesNas) await this.connectNas();
      this.changingSpace = true;
      this.preferences.activeSpace = this.workspace ? "enterprise" : "personal";
      await this.save();
      this.reload();
    }
    return result;
  }
  async chooseFolder(reload = true, reuseExisting = false) {
    this.assertAccount();
    await this.flush();
    const choice =
      reuseExisting && this.folder
        ? { canceled: false, filePaths: [this.folder] }
        : await dialog.showOpenDialog({
            title: "选择公司账号的本地画板文件夹",
            properties: ["openDirectory", "createDirectory"],
          });
    if (choice.canceled || !choice.filePaths[0]) return this.status;
    this.changingSpace = true;
    this.preferences.folders[this.namespace!] = path.resolve(
      choice.filePaths[0],
    );
    this.preferences.storage ??= {};
    this.preferences.storage[this.namespace!] = { kind: "local" };
    this.preferences.activeSpace = "enterprise";
    this.legacy.stop();
    await mkdir(this.workspace!, { recursive: true, mode: 0o700 });
    await this.save();
    if (reload) this.reload();
    else this.changingSpace = false;
    return this.status;
  }
  async connectNas() {
    this.assertAccount();
    const url = this.storage?.url,
      identity = this.namespace;
    if (!url) throw new Error("请配置公司 NAS 存储地址。");
    await this.legacy.useStorageSession(url, async () => {
      if (this.namespace !== identity || !this.usesNas)
        throw new Error("公司存储会话已更改。");
      const grant = await this.account.storageToken(),
        session = this.account.session!;
      this.nasImageWritable =
        grant.scopes.includes("boards:write") &&
        grant.scopes.includes("assets:write");
      return {
        token: grant.token,
        expiresAt: grant.expiresAt,
        organizationId: session.organization.id,
        organizationName: session.organization.name,
        user: {
          ...session.member,
          role: grant.scopes.includes("boards:write") ? "editor" : "viewer",
        },
      };
    });
  }
  async chooseNas(input: string) {
    this.assertAccount();
    await this.flush();
    const url = new URL(input);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("NAS 存储地址无效。");
    const previous = this.preferences.storage?.[this.namespace!];
    const previousSpace = this.preferences.activeSpace;
    this.changingSpace = true;
    this.preferences.storage ??= {};
    this.preferences.storage[this.namespace!] = {
      kind: "nas",
      url: url.origin,
    };
    try {
      await this.connectNas();
      this.preferences.activeSpace = "enterprise";
      await this.save();
      this.reload();
      return this.status;
    } catch (e) {
      this.preferences.activeSpace = previousSpace;
      this.changingSpace = false;
      if (previous) this.preferences.storage[this.namespace!] = previous;
      else delete this.preferences.storage[this.namespace!];
      throw e;
    }
  }
  async selectSpace(space: SpaceKind) {
    if (!this.enabled) return this.legacy.selectSpace(space);
    if (space !== "personal" && space !== "enterprise")
      throw new Error("空间类型无效。");
    await this.flush();
    if (space === "enterprise") {
      this.assertAccount();
      if (!this.workspace) await this.chooseFolder(false);
    }
    this.changingSpace = true;
    this.preferences.activeSpace =
      space === "enterprise" && !this.workspace ? "personal" : space;
    await this.save();
    this.reload();
    return this.status;
  }
  nasBoards(local: BoardStore): BoardStore {
    const channels: Record<string, string> = {
      getBoard: "boards:get",
      getBoardWithVerifiedImageDimensions: "boards:get",
      listSummaries: "boards:list",
      createBoard: "boards:create",
      saveBoard: "boards:save",
      renameBoard: "boards:rename",
      appendNodes: "boards:appendNodes",
      appendVersions: "boards:appendVersions",
      writeCanvasNode: "boards:canvas:write",
      finishGenerationNode: "boards:finishGeneration",
      setLastOpenedBoardId: "boards:setLastOpened",
    };
    return new Proxy(local, {
      get: (target, property) => {
        this.assertStorage();
        if (!this.usesNas || executionSpace() !== "enterprise") {
          const v = Reflect.get(target, property, target);
          return typeof v === "function" ? v.bind(target) : v;
        }
        this.assertAccount();
        if (property === "getLastOpenedBoardId")
          return async () => {
            const state = await this.legacy.command("boards:getState", []);
            return state.lastOpenedBoardId;
          };
        const channel = channels[String(property)];
        if (!channel) throw new Error("该画板操作尚未接入 NAS 空间。");
        return (...args: unknown[]) => this.legacy.command(channel, args);
      },
    });
  }
  nasAssets(local: AssetStore): AssetStore {
    return new Proxy(local, {
      get: (target, property) => {
        this.assertStorage();
        const original = Reflect.get(target, property, target),
          bound =
            typeof original === "function" ? original.bind(target) : original;
        if (!this.usesNas || executionSpace() !== "enterprise") return bound;
        this.assertAccount();
        if (property === "saveOutputs")
          return async (
            _job: string,
            images: Array<{ bytes: Buffer; mimeType: string }>,
          ) =>
            Promise.all(
              images.map(
                async (image) =>
                  (
                    await this.legacy.command("asset:importUpload", [
                      `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
                    ])
                  ).path,
              ),
            );
        if (
          [
            "readManagedBytes",
            "readManagedDataUrl",
            "toDataUrl",
            "toAssetUrl",
          ].includes(String(property))
        )
          return (file: string) => {
            if (!file.startsWith(ENTERPRISE_ASSET_PREFIX)) return bound(file);
            if (property === "toAssetUrl")
              return (
                "tuda-asset://enterprise/" +
                file.slice(ENTERPRISE_ASSET_PREFIX.length)
              );
            return this.legacy
              .command("asset:readDataUrl", [file])
              .then((data) =>
                property === "readManagedBytes"
                  ? Buffer.from(String(data).split(",")[1], "base64")
                  : data,
              );
          };
        return bound;
      },
    });
  }
  private assertStorage() {
    const c = executionContext();
    if (
      c.space === "enterprise" &&
      c.storage?.kind === "nas" &&
      (this.storage?.kind !== "nas" || this.storage.url !== c.storage.url)
    )
      throw new Error("任务所属 NAS 存储已切换，结果保留在原任务目录。");
  }
  async logout() {
    if (!this.enabled) return this.legacy.logout();
    await this.flush();
    this.changingSpace = true;
    this.legacy.stop();
    try {
      await this.account.logout();
    } finally {
      this.preferences.activeSpace = "personal";
      await this.save();
      this.reload();
    }
    return this.status;
  }
  overlaySettings(settings: AppSettings): AppSettings {
    this.assertAccount();
    const b = this.account.bootstrap,
      s = this.namespace
        ? this.preferences.selections[this.namespace]
        : undefined;
    const providers: ProviderConfig[] = b?.image.enabled
      ? b.image.models.map((model) => ({
          id: "company-image/" + model,
          name: "ToAPIs · " + model,
          type: "openai-compatible",
          transport: "toapiscli",
          baseUrl: "",
          generationEndpoint: "",
          model,
          models: [model],
          supportsReferenceImages: true,
        }))
      : [];
    const textProviders: TextProviderConfig[] = b?.text.enabled
      ? b.text.providers.flatMap((p) =>
          p.models.map((m) => ({
            id: `company-text/${p.id}/${m.id}`,
            name: m.name,
            type: "openai-compatible" as const,
            protocol: p.protocol,
            managed: true,
            baseUrl: p.baseUrl,
            model: m.id,
          })),
        )
      : [];
    const selectedText =
      textProviders.find((p) => p.id === s?.text)?.id ??
      textProviders.find((p) => p.id === `company-text/${b?.text.defaultModel}`)
        ?.id ??
      textProviders[0]?.id ??
      "";
    return {
      ...settings,
      providers,
      activeProviderId:
        providers.find((p) => p.id === s?.image)?.id ?? providers[0]?.id ?? "",
      textProviders,
      activeTextProviderId: selectedText,
      videoProviders: [],
      activeVideoProviderId: "",
      audioProviders: [],
      activeAudioProviderId: "",
      memoryEnabled: false,
      cliDefaultBoardId: undefined,
      boardAssistantEnabled: true,
      boardAssistantAgentModeEnabled: true,
      assistantAgentModeEnabled: true,
    };
  }
  token(id?: string) {
    this.assertAccount();
    const b = this.account.bootstrap;
    if (id?.startsWith("company-text/") && b?.text.enabled)
      return this.account.session!.token;
    if (
      id?.startsWith("company-image/") &&
      b?.image.enabled &&
      this.imageConfigured
    )
      return "managed-toapis";
    return "";
  }
  async selectModels(value: Record<string, unknown>) {
    this.assertAccount();
    const selection = this.preferences.selections[this.namespace!] ?? {};
    if (typeof value.activeProviderId === "string")
      selection.image = value.activeProviderId;
    if (typeof value.activeTextProviderId === "string")
      selection.text = value.activeTextProviderId;
    this.preferences.selections[this.namespace!] = selection;
    await this.save();
  }
  /** Every async operation is pinned to its starting folder and account. */
  scopeStore<T extends object>(personal: T, create: (root: string) => T): T {
    const stores = new Map<string, T>();
    return new Proxy(personal, {
      get: (target, property) => {
        if (!this.enabled || executionSpace() !== "enterprise") {
          const v = Reflect.get(target, property, target);
          return typeof v === "function" ? v.bind(target) : v;
        }
        this.assertAccount();
        const root = executionContext().workspace;
        if (!root) throw new Error("请先为公司账号选择本地文件夹。");
        let store = stores.get(root);
        if (!store) {
          store = create(root);
          stores.set(root, store);
        }
        const v = Reflect.get(store, property, store);
        return typeof v === "function" ? v.bind(store) : v;
      },
    });
  }
  stop() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
