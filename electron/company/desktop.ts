import { defaultTudaTextProvider } from "../../shared/tuda-models.js";
import { BrowserWindow, net, safeStorage } from "electron";
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
import { directProvider, directTextProviders } from "./direct-models.js";
import type { CompanyDefaults } from "./defaults.js";
import { comicBoardSnapshot } from "../domain/comic-board-snapshot.js";
import {
  executionContext,
  storedExecutionContext,
  inExecutionContext,
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
  profiles?: Record<string, {nickname?: string}>;
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
  private nasConnectionError?: string;
  private profileLogin = false;
  changingSpace = false;
  constructor(
    readonly userData: string,
    readonly legacy: EnterpriseClient,
    private readonly defaults: CompanyDefaults = {},
    private readonly connectionOnly = false,
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
        // Embedded sessions are short-lived grants from the live host, not independent logins.
        if (this.connectionOnly || process.env.TUDA_EMBEDDED_HOST) return;
        if (!safeStorage.isEncryptionAvailable())
          throw new Error("系统安全存储不可用，未保存公司登录凭据。");
        const encrypted = safeStorage
          .encryptString(JSON.stringify(value))
          .toString("base64");
        await this.write("company-session.json", { version: 1, encrypted });
      },
      (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
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
          throw new Error("NAS 连接失败，请先切换本地空间完成工作。");
        if (
          executionSpace() === "enterprise" &&
          this.usesNas &&
          !this.nasImageWritable
        )
          throw new Error(
            "当前 NAS 存储为只读，请切换本地空间后生成图片。",
          );
      },
      input => this.account.guestImage(input),
    );
    if (!this.connectionOnly) this.account.on("state", () => {
      this.changed();
      void this.prepareImage();
    });
    if (!this.connectionOnly) this.legacy.on("state", () => {
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
    if (this.account.session?.accountKind === "password") return "personal" as const;
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
    if (this.account.session?.accountKind === "password") return undefined;
    if (!this.namespace) return undefined;
    const previous = this.preferences.storage?.[this.namespace];
    const url = previous?.kind === "nas" ? previous.url : this.defaultNasUrl;
    return url ? {kind: "nas" as const, url} : undefined;
  }
  private get defaultNasUrl() {
    return this.defaults.nasUrl || this.legacy.status.serverUrl;
  }
  get usesNas() {
    return this.enabled && this.storage?.kind === "nas";
  }
  get workspace() {
    if (this.account.session?.accountKind === "password" && this.namespace) return path.join(this.userData, "guest-workspaces", this.namespace);
    return this.usesNas && this.namespace ? path.join(this.userData, "company-cache", this.namespace) : undefined;
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
      accountKind: this.account.session?.accountKind,
      accountNickname: this.namespace ? this.preferences.profiles?.[this.namespace]?.nickname : undefined,
      storageKind: this.usesNas ? "nas" : "local",
      storageUrl: this.account.session?.accountKind === "password" ? undefined : this.storage?.url ?? this.defaultNasUrl,
      storageError: this.nasConnectionError,

      textModels: a.textModels,
      imageModels: a.imageModels,
      imageConfigured: this.imageConfigured,
      imageReason: a.imageReason,
      configVersion: a.configVersion,
    };
  }
  private changed() {
    if (this.connectionOnly) return;
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
      const origin = typeof p.origin === "string" && p.origin.trim()
        ? p.origin.trim() : this.preferences.origin;
      this.preferences = { ...p, origin };
      await this.account.configure(origin, false);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (this.enabled) {
      this.legacy.stop();
      try {
        if (!process.env.TUDA_EMBEDDED_HOST) {
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
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn("公司登录需重新授权。");
      }
      if (this.account.authenticated)
        await this.account
          .refresh()
          .then(async () => {
            if (this.usesNas) {
              try { await this.connectNas(); }
              catch { this.preferences.activeSpace = "personal"; await this.save(); this.changed(); }
            }
          })
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
    }, 120_000);
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
  async updateProfile(nickname: unknown) {
    this.assertAccount();
    if (typeof nickname !== "string" || nickname.trim().length > 40 || Array.from(nickname).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("昵称请使用 40 字以内的有效文字。");
    this.preferences.profiles ??= {};
    this.preferences.profiles[this.namespace!] = {nickname: nickname.trim() || undefined};
    await this.save();this.changed();return this.status;
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
  async beginLogin(refreshProfile = false) {
    if (this.enabled && this.account.authenticated && !refreshProfile)
      throw new Error("当前已登录公司账号，请先退出后切换账号。");
    if (refreshProfile) await this.flush();
    this.profileLogin = refreshProfile;
    return this.enabled ? this.account.beginLogin(refreshProfile) : this.legacy.beginLogin();
  }
  async passwordLogin(username: string, password: string) {
    if (!this.enabled) throw new Error("账号服务尚未配置。");
    if (this.account.authenticated) throw new Error("请先退出当前账号。");
    await this.flush();
    const result = await this.account.passwordLogin(username, password);
    this.preferences.activeSpace = "personal";
    await this.save(); this.reload();
    return result;
  }
  /** Internal host integration: no dialogs, credentials or personal-space fallback. */
  async authorizeHostOperation() {
    if (!this.enabled || !this.account.authenticated) throw new Error("COMPANY_AUTH_REQUIRED");
    await this.account.refresh();
    this.assertAccount();
  }
  async acceptHostHandoff(value: unknown) {
    if (!this.enabled) throw new Error("COMPANY_AUTH_NOT_CONFIGURED");
    await this.flush();
    const result = await this.account.acceptHostHandoff(value);
    if (!this.usesNas) throw new Error("企业空间固定使用 NAS，请先配置 NAS 服务。");
    await this.connectNas();
    this.preferences.activeSpace = "enterprise";
    await this.save();
    this.reload();
    return { ...result, space: "enterprise" };
  }
  /** A connection gets its own in-memory account and storage client. UI preferences stay untouched. */
  async createPluginConnection(value: unknown, legacy: EnterpriseClient) {
    const connection = new CompanyDesktop(this.userData, legacy, this.defaults, true);
    connection.preferences = structuredClone(this.preferences);
    await connection.account.configure(this.account.origin, false);
    try {
      await connection.account.acceptHostHandoff(value);
      if (connection.account.bootstrap?.text.enabled || connection.account.bootstrap?.image.enabled)
        throw new Error("PLUGIN_SESSION_SCOPE_INVALID");
      if (!connection.namespace) throw new Error("COMPANY_AUTH_REQUIRED");
      if (!connection.usesNas) throw new Error("企业空间固定使用 NAS，请先配置 NAS 服务。");
      await inExecutionContext({space:"enterprise",account:connection.namespace,workspace:connection.workspace,storage:connection.storage,pluginCompany:connection}, () => connection.connectNas());
      connection.preferences.activeSpace = "enterprise";
      return connection;
    } catch (error) { legacy.stop(); throw error; }
  }
  async pollLogin() {
    if (!this.enabled) return this.legacy.pollLogin();
    const result = await this.account.pollLogin();
    if (result.status === "authorized") {
      if (this.profileLogin) { await this.flush(); this.profileLogin = false; }
      // Company identity/model authorization is independent of NAS availability.
      let nasAvailable = false;
      if (this.usesNas) { try { await this.connectNas(); nasAvailable = true; } catch { /* Login is valid; use local storage. */ } }
      this.changingSpace = true;
      this.preferences.activeSpace = nasAvailable ? "enterprise" : "personal";
      await this.save();
      this.reload();
    }
    return result;
  }
  async chooseFolder(_reload = true, _reuseExisting = false) {
    void _reload; void _reuseExisting;
    this.assertAccount();
    throw new Error("企业空间固定使用 NAS。请切换到本地空间继续工作。");
  }
  async connectNas() {
    this.assertAccount();
    const url = this.storage?.url,
      identity = this.namespace;
    if (!url) { this.nasConnectionError = "NAS 连接失败，请先使用本地空间完成工作。"; throw new Error(this.nasConnectionError); }
    try {
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
    this.nasConnectionError = undefined;
    } catch {
      this.nasConnectionError = "NAS 连接失败，请先使用本地空间完成工作。";
      this.changed();
      throw new Error(this.nasConnectionError);
    }
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
    this.assertAccount();
    if (space === "enterprise" && this.account.session?.accountKind === "password") throw new Error("当前账号仅开放本地空间。");
    if (space !== "personal" && space !== "enterprise") throw new Error("空间类型无效。");
    await this.flush();
    if (space === "enterprise") {
      try { await this.connectNas(); }
      catch {
        this.preferences.activeSpace = "personal";
        await this.save(); this.reload(); return this.status;
      }
    }
    this.changingSpace = true;
    this.preferences.activeSpace = space;
    await this.save(); this.reload(); return this.status;
  }
  nasBoards(local: BoardStore): BoardStore {
    const channels: Record<string, string> = {
      getBoard: "boards:get",
      getBoardWithVerifiedImageDimensions: "boards:get",
      listSummaries: "boards:list",
      getBoardLibrary: "boards:library:get",
      updateBoardLibrary: "boards:library:update",
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
        if (storedExecutionContext()?.account && storedExecutionContext()!.account !== this.namespace) throw new Error("账号已切换，请重新打开当前画板。");
        this.assertStorage();
        if (!this.usesNas || executionSpace() !== "enterprise") {
          const v = Reflect.get(target, property, target);
          return typeof v === "function" ? v.bind(target) : v;
        }
        this.assertAccount();
        if (property === "listBoards") return async () => {
          const summaries = await this.legacy.command("boards:list", []) as Array<{id:string}>;
          const boards = await Promise.all(summaries.map(summary => this.legacy.command("boards:get", [summary.id])));
          return boards.filter(Boolean);
        };
        if (property === "getComicDramaBoardSnapshot")
          return async (id: string) => {
            const board = await this.legacy.command("boards:get", [id]);
            if (!board) throw new Error("画板不存在或已移入回收站。");
            return comicBoardSnapshot(board);
          };
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
        if (property === "isReadable") return (file: string) => file.startsWith(ENTERPRISE_ASSET_PREFIX)
          ? this.legacy.command("asset:readDataUrl", [file]).then(() => true, () => false) : bound(file);
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
    const direct = this.account.directModels;
    const textProviders: TextProviderConfig[] = b?.text.enabled && b.text.transport === "proxy"
      ? b.text.providers.flatMap(provider => provider.models.map(model => ({ id: `company-text/${provider.id}/${model.id}`, name: model.name, type: "openai-compatible" as const,
        managed: true, protocol: provider.protocol, baseUrl: provider.baseUrl, model: model.id })))
      : b?.text.enabled && direct ? directTextProviders(direct) : [];
    const selectedText = defaultTudaTextProvider(textProviders, s?.text, direct?.model);
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
    if (id?.startsWith("company-text/") && b?.text.enabled) {
      if (b.text.transport === "proxy" && this.account.session?.accountKind === "password") return this.account.session.token;
      if (!this.account.directModels) return "";
      directProvider(this.account.directModels, id);
      // Generic settings/SDK callers receive a marker. Account.textFetch injects the real Key.
      return "managed-direct-text";
    }
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
        if (storedExecutionContext()?.account && storedExecutionContext()!.account !== this.namespace) throw new Error("账号已切换，请重新打开当前画板。");
        if (!this.enabled || (executionSpace() !== "enterprise" && this.account.session?.accountKind !== "password")) {
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
    this.account.stopAuthorization();
  }
}

/** Existing service adapters capture this facade, so scoped async calls resolve their own account. */
export function scopedCompany(desktop: CompanyDesktop): CompanyDesktop {
  const active = () => storedExecutionContext()?.pluginCompany as CompanyDesktop | undefined ?? desktop;
  return new Proxy(desktop, {
    get(_target, key, receiver) { const value = Reflect.get(active(), key, receiver); return typeof value === "function" ? value.bind(receiver) : value; },
    set(_target, key, value) { return Reflect.set(active(), key, value); }
  });
}
