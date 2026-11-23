import { defaultTudaTextProvider } from "../../shared/tuda-models.js";
import { findTextModelRoute, groupModelChannels, resolveImageRouting, textModelRouteId } from "../../shared/image-routing.js";
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
import { CompanyAccount, companyOrigin, type AccountSnapshot } from "./account.js";
import { CompanyToapis } from "./toapis.js";
import { directProvider, directTextProviders } from "./direct-models.js";
import { mergeManagedRouting } from "./managed-models.js";
import type { CompanyDefaults } from "./defaults.js";
import type { CompanyStorageMode } from "../../shared/company-account.js";
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
  private readonly omniOrigin: string;
  private readonly legacyWorkspaceOrigin: string;
  private preferences: Preferences;
  private savedFiles = new Set<string>();
  private writing = Promise.resolve();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private nasImageWritable = false;
  private imageRevision = "";
  private imageConfigured = false;
  private imageSetupError?: string;
  private nasConnectionError?: string;
  private connectedStorageRoute?: string;
  private storageConnection?: Promise<void>;
  private loginPoll?: ReturnType<CompanyAccount["pollLogin"]>;
  private completingOmniLogin = false;
  private profileLogin = false;
  changingSpace = false;
  constructor(
    readonly userData: string,
    readonly legacy: EnterpriseClient,
    private readonly defaults: CompanyDefaults = {},
    private readonly connectionOnly = false,
  ) {
    this.omniOrigin = defaults.omniOrigin ? companyOrigin(defaults.omniOrigin) : "";
    const legacyOrigin = process.env.TUDA_COMPANY_URL?.trim() || defaults.accountOrigin || "";
    const workspaceOrigin = defaults.legacyWorkspaceOrigin || legacyOrigin;
    this.legacyWorkspaceOrigin = this.omniOrigin && workspaceOrigin ? companyOrigin(workspaceOrigin) : "";
    this.preferences = {
      version: 1,
      origin: legacyOrigin,
      activeSpace: "personal",
      folders: {},
      selections: {},
    };
    this.account = new CompanyAccount(
      this.omniOrigin || this.preferences.origin,
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
    );
    if (!this.connectionOnly) this.account.on("state", () => {
      if (this.onOmni && this.connectedStorageRoute && this.connectedStorageRoute !== this.storageRoute) {
        this.connectedStorageRoute = undefined;
        this.legacy.stop();
        if (this.account.authenticated) this.nasConnectionError = "企业存储来源或权限已更新，请重新连接企业空间。";
      }
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
      !this.account.hasManagedModelContract && b?.image.enabled && this.namespace
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
  get readyForWorkspace() {
    return this.account.authenticated && !this.completingOmniLogin;
  }
  get activeSpace() {
    return this.enabled
      ? this.preferences.activeSpace
      : this.legacy.activeSpace;
  }
  get namespace() {
    const s = this.account.session;
    const origin = this.onOmni && s?.legacyWorkspace && this.legacyWorkspaceOrigin
      ? this.legacyWorkspaceOrigin : this.account.origin;
    return s
      ? createHash("sha256")
          .update(
            JSON.stringify([
              origin,
              s.organization.id,
              s.member.id,
            ]),
          )
          .digest("hex")
      : undefined;
  }
  private get onOmni() {
    return !!this.omniOrigin && this.account.origin === this.omniOrigin;
  }
  private get hasEnterpriseStorageGrant() {
    const storage = this.account.bootstrap?.storage;
    return !!storage?.enabled && !!storage.mode && !!storage.endpoint && (storage.scopes?.includes("boards:read") ?? true);
  }
  get folder() {
    return this.namespace
      ? this.preferences.folders[this.namespace]
      : undefined;
  }
  get storage(): { kind: "nas"; url: string; mode?: CompanyStorageMode } | undefined {
    if (!this.namespace) return undefined;
    if (this.onOmni) {
      const storage = this.account.bootstrap?.storage;
      return this.hasEnterpriseStorageGrant && storage?.endpoint
        ? { kind: "nas", url: storage.endpoint, mode: storage.mode }
        : undefined;
    }
    const previous = this.preferences.storage?.[this.namespace];
    const url = previous?.kind === "nas" ? previous.url : this.defaultNasUrl;
    return url ? {kind: "nas" as const, url} : undefined;
  }
  private get storageRoute() {
    const storage = this.storage;
    return storage && JSON.stringify([this.namespace, storage.mode, storage.url]);
  }
  private get defaultNasUrl() {
    return this.defaults.nasUrl || this.legacy.status.serverUrl;
  }
  get usesNas() {
    return this.enabled && this.storage?.kind === "nas";
  }
  get workspace() {
    return this.usesNas && this.namespace ? path.join(this.userData, "company-cache", this.namespace) : undefined;
  }
  get status(): EnterpriseStatus {
    if (!this.enabled) return this.legacy.status;
    const a = this.account.status;
    return {
      configured: true,
      serverUrl: a.authenticated ? this.account.origin : this.omniOrigin || this.account.origin,
      activeSpace: this.activeSpace,
      authenticated: this.readyForWorkspace,
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
      accountProvider: this.omniOrigin ? "omni" : undefined,
      accountNickname: this.namespace ? this.preferences.profiles?.[this.namespace]?.nickname : undefined,
      storageKind: this.usesNas ? "nas" : "local",
      ...(this.onOmni ? { enterpriseStorageAuthorized: this.hasEnterpriseStorageGrant, storageSource: this.storage?.mode } : {}),
      storageUrl: this.storage?.url ?? (this.onOmni ? undefined : this.defaultNasUrl),
      storageError: this.nasConnectionError,

      textModels: a.textModels,
      imageModels: a.imageModels,
      imageConfigured: this.account.hasManagedModelContract
        ? Boolean(this.account.managedModels?.routing.image.models.length) : this.imageConfigured,
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
    if (!this.omniOrigin) this.preferences.origin = this.account.origin;
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
      if (!this.omniOrigin) await this.account.configure(origin, false);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (this.enabled) {
      this.legacy.stop();
      if (!process.env.TUDA_EMBEDDED_HOST) {
        try {
          const saved = JSON.parse(await readFile(path.join(this.userData, "company-session.json"), "utf8"));
          if (saved.version !== 1 || !safeStorage.isEncryptionAvailable())
            throw new Error("无法解密公司会话。");
          const snapshot = JSON.parse(
            safeStorage.decryptString(Buffer.from(saved.encrypted, "base64")),
          ) as AccountSnapshot;
          if (this.onOmni && snapshot.session?.accountKind !== "password") await this.account.restore(snapshot);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn("公司登录需重新授权。");
        }
      }
      if (this.account.authenticated)
        await this.account
          .refresh()
          .then(async () => {
            if (this.usesNas) {
              try { await this.connectNas(); }
              catch { this.preferences.activeSpace = "personal"; await this.save(); this.changed(); }
            } else if (this.onOmni) {
              this.preferences.activeSpace = "personal";
              this.changed();
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
  assertNasAccess(requireConnection = true) {
    this.assertAccount();
    if (this.onOmni && !this.hasEnterpriseStorageGrant)
      throw new Error("当前账号未获企业存储授权，可选择本地空间继续工作。");
    if (requireConnection && this.onOmni && this.storageRoute !== this.connectedStorageRoute)
      throw new Error("请重新连接企业空间。");
  }
  async updateProfile(nickname: unknown) {
    this.assertAccount();
    if (typeof nickname !== "string" || nickname.trim().length > 40 || Array.from(nickname).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("昵称请使用 40 字以内的有效文字。");
    this.preferences.profiles ??= {};
    this.preferences.profiles[this.namespace!] = {nickname: nickname.trim() || undefined};
    await this.save();this.changed();return this.status;
  }
  async configure(origin: string) {
    if (this.omniOrigin) throw new Error("山海服务地址由 Tuda 部署配置管理。");
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
    if (!this.omniOrigin) throw new Error("山海账号服务尚未配置，请联系管理员。");
    if (this.enabled && this.account.authenticated && !refreshProfile)
      throw new Error("当前已登录公司账号，请先退出后切换账号。");
    if (refreshProfile && (!this.onOmni || !this.account.authenticated))
      throw new Error("请先登录山海企业账号。");
    if (refreshProfile) await this.flush();
    if (!this.onOmni) {
      await this.account.configure(this.omniOrigin, false);
    }
    this.profileLogin = refreshProfile;
    return this.account.beginLogin(refreshProfile);
  }
  /** Internal host integration: no dialogs, credentials or personal-space fallback. */
  async authorizeHostOperation() {
    if (!this.enabled || !this.account.authenticated) throw new Error("COMPANY_AUTH_REQUIRED");
    await this.account.refresh();
    this.assertAccount();
  }
  async acceptHostHandoff(value: unknown) {
    if (!this.enabled) throw new Error("COMPANY_AUTH_NOT_CONFIGURED");
    if (this.omniOrigin && !this.onOmni) throw new Error("AUTH_HANDOFF_UNAVAILABLE");
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
    await connection.account.configure(this.omniOrigin || this.account.origin, false);
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
  pollLogin() {
    if (!this.onOmni) throw new Error("请先发起山海账号登录。");
    if (this.loginPoll) return this.loginPoll;
    const firstOmniLogin = !this.profileLogin && !this.account.authenticated;
    this.completingOmniLogin = firstOmniLogin;
    const poll = this.finishLogin(firstOmniLogin).finally(() => {
      if (this.loginPoll !== poll) return;
      this.loginPoll = undefined;
      this.completingOmniLogin = false;
      if (firstOmniLogin) this.changed();
    });
    this.loginPoll = poll;
    return poll;
  }
  cancelLogin() {
    if (!this.account.cancelLogin()) return false;
    this.loginPoll = undefined;
    this.completingOmniLogin = false;
    this.profileLogin = false;
    return true;
  }
  private async finishLogin(firstOmniLogin: boolean) {
    const result = await this.account.pollLogin();
    if (result.status === "authorized") {
      if (this.profileLogin) { await this.flush(); this.profileLogin = false; }
      let enterpriseAvailable = false;
      if (this.usesNas) {
        try { await this.connectNas(); enterpriseAvailable = true; } catch { /* Use local storage after a connection failure. */ }
      }
      this.preferences.activeSpace = enterpriseAvailable ? "enterprise" : "personal";
      await this.save();
      if (!firstOmniLogin) {
        this.changingSpace = true;
        this.reload();
      }
    }
    return result;
  }
  async chooseFolder(_reload = true, _reuseExisting = false) {
    void _reload; void _reuseExisting;
    this.assertAccount();
    throw new Error(this.onOmni ? "企业空间由山海管理。请切换到本地空间继续工作。" : "企业空间固定使用 NAS。请切换到本地空间继续工作。");
  }
  connectNas() {
    return this.storageConnection ??= this.connectStorage().finally(() => {
      this.storageConnection = undefined;
    });
  }
  private async connectStorage() {
    this.assertNasAccess(false);
    const url = this.storage?.url, route = this.storageRoute;
    const assertRoute = () => {
      if (!route || this.storageRoute !== route) throw new Error("企业存储来源已更改。");
    };
    const connectionError = this.onOmni
      ? "企业空间连接失败，请先使用本地空间完成工作。"
      : "NAS 连接失败，请先使用本地空间完成工作。";
    try {
      if (!url) throw new Error(connectionError);
      await this.legacy.useStorageSession(url, async () => {
        assertRoute();
        const grant = await this.account.storageToken();
        assertRoute();
        const session = this.account.session!;
        this.nasImageWritable = grant.scopes.includes("boards:write") && grant.scopes.includes("assets:write");
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
      assertRoute();
      this.connectedStorageRoute = route;
      this.nasConnectionError = undefined;
    } catch {
      if (this.onOmni) {
        this.connectedStorageRoute = undefined;
        this.legacy.stop();
      }
      this.nasConnectionError = connectionError;
      this.changed();
      throw new Error(this.nasConnectionError);
    }
  }
  async chooseNas(input: string) {
    this.assertAccount();
    if (this.onOmni) throw new Error("企业存储来源由山海管理员配置。");
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
    if (space === "enterprise" && this.onOmni && !this.hasEnterpriseStorageGrant) throw new Error("当前账号仅开放本地空间。");
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
        this.assertNasAccess();
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
        this.assertNasAccess();
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
      (this.storage?.kind !== "nas" || this.storage.url !== c.storage.url || this.storage.mode !== c.storage.mode)
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
  overlaySettings(settings: AppSettings, localModels?: AppSettings): AppSettings {
    this.assertAccount();
    const b = this.account.bootstrap,
      s = this.namespace
        ? this.preferences.selections[this.namespace]
        : undefined;
    const managed = this.account.managedModels;
    if (this.account.hasManagedModelContract) {
      const personal = {
        image: localModels?.imageRouting,
        other: localModels?.otherModelRouting
      };
      const route = managed?.routing;
      const fallback = { models: [], defaultModel: "" };
      const locals = {
        text: localModels?.textProviders ?? [], video: localModels?.videoProviders ?? [], audio: localModels?.audioProviders ?? []
      };
      const personalRoute = (kind: "text" | "video" | "audio") => personal.other?.[kind] ??
        groupModelChannels(locals[kind].filter(provider => Boolean(provider.model)).map(({ id, model }) => ({ providerId: id, model })));
      const text = mergeManagedRouting(route?.text ?? fallback, personalRoute("text"));
      const textProviders = [...managed?.textProviders ?? [], ...locals.text];
      const savedText = s?.text;
      const savedManagedRoute = route?.text.models.find(model => model.channels.some(channel => channel.providerId === savedText));
      const preferredText = savedManagedRoute ? textModelRouteId(savedManagedRoute.name)
        : savedText && (findTextModelRoute({ text }, savedText) || textProviders.some(provider => provider.id === savedText))
          ? savedText : undefined;
      return {
        ...settings,
        companyModelRouting: route ?? { text: fallback, image: fallback, video: fallback, audio: fallback },
        personalModelRouting: personal,
        providers: [...managed?.providers ?? [], ...localModels?.providers ?? []],
        textProviders,
        videoProviders: [...managed?.videoProviders ?? [], ...locals.video],
        audioProviders: [...managed?.audioProviders ?? [], ...locals.audio],
        imageRouting: mergeManagedRouting(route?.image ?? fallback,
          resolveImageRouting(personal.image, localModels?.providers ?? [], localModels?.activeProviderId ?? "")),
        otherModelRouting: {
          text,
          video: mergeManagedRouting(route?.video ?? fallback, personalRoute("video")),
          audio: mergeManagedRouting(route?.audio ?? fallback, personalRoute("audio"))
        },
        activeProviderId: route?.image.models.find(model => model.name === route.image.defaultModel)?.channels[0].providerId
          ?? localModels?.activeProviderId ?? "",
        activeTextProviderId: preferredText ?? (route?.text.defaultModel
          ? textModelRouteId(route.text.defaultModel) : localModels?.activeTextProviderId ?? ""),
        activeVideoProviderId: route?.video.models.find(model => model.name === route.video.defaultModel)?.channels[0].providerId
          ?? localModels?.activeVideoProviderId ?? "",
        activeAudioProviderId: route?.audio.models.find(model => model.name === route.audio.defaultModel)?.channels[0].providerId
          ?? localModels?.activeAudioProviderId ?? "",
        memoryEnabled: false,
        cliDefaultBoardId: undefined,
        boardAssistantEnabled: true,
        boardAssistantAgentModeEnabled: true,
        assistantAgentModeEnabled: true
      };
    }
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
    const imageModels = [...providers, ...localModels?.providers ?? []];
    const availableText = [...textProviders, ...localModels?.textProviders ?? []];
    const managedDefault = this.onOmni && direct ? `company-text/${direct.model}` : undefined;
    const selectedRoute = [s?.text, s?.text ? undefined : localModels?.activeTextProviderId]
      .find(id => findTextModelRoute(localModels?.otherModelRouting, id));
    const selectedText = selectedRoute ?? availableText.find(provider => provider.id === s?.text)?.id
      ?? (textProviders.length
        ? defaultTudaTextProvider(textProviders, managedDefault, direct?.model)
        : defaultTudaTextProvider(availableText, localModels?.activeTextProviderId));
    return {
      ...settings,
      providers: imageModels,
      imageRouting: localModels?.imageRouting,
      otherModelRouting: localModels?.otherModelRouting,
      activeProviderId:
        imageModels.find((p) => p.id === s?.image)?.id ?? providers[0]?.id ?? localModels?.activeProviderId ?? "",
      textProviders: availableText,
      activeTextProviderId: selectedText,
      videoProviders: localModels?.videoProviders ?? [],
      activeVideoProviderId: localModels?.activeVideoProviderId ?? "",
      audioProviders: localModels?.audioProviders ?? [],
      activeAudioProviderId: localModels?.activeAudioProviderId ?? "",
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
    if (id && /^company-(text|image|video|audio)\/sync\//u.test(id)) {
      const key = this.account.managedModels?.keys[id] ?? "";
      return key && id.startsWith("company-text/") ? "managed-direct-text" : key;
    }
    if (id?.startsWith("company-text/") && b?.text.enabled) {
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
