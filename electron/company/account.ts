import { installModelNetworkAudit, withModelTrace } from "../debug-network.js";
import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import type {
  CompanyAccountPublicStatus,
  CompanyBootstrap,
  CompanyDirectModels,
  CompanySession,
} from "../../shared/company-account.js";
import { COMPANY_IMAGE_MODELS } from "../../shared/company-account.js";
import { directDigest, directProvider, validateDirectModels } from "./direct-models.js";
import type { TextProviderConfig } from "../../shared/types.js";

const prefix = "/api/company/v1";
const opaque = /^[A-Za-z0-9_-]{43}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown) => {
  if (!record(v) || typeof v.id !== "string" || !v.id || typeof v.name !== "string") return false;
  if (v.avatarUrl !== undefined) {
    try { const url = new URL(String(v.avatarUrl)); if (typeof v.avatarUrl !== "string" || url.protocol !== "https:" || url.username || url.password || v.avatarUrl.length > 4096) return false; }
    catch { return false; }
  }
  return true;
};
export function companyOrigin(input: string) {
  const url = new URL(input);
  const local =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("公司账号服务须使用 HTTPS 地址。");
  return url.origin;
}
export function validateBootstrap(
  value: unknown,
  session: CompanySession,
  origin: string,
): CompanyBootstrap {
  if (
    !record(value) ||
    value.contract !== 1 ||
    value.appId !== "tuda" ||
    value.sessionId !== session.sessionId ||
    !identity(value.member) ||
    !identity(value.organization) ||
    (value.member as { id: string }).id !== session.member.id ||
    (value.organization as { id: string }).id !== session.organization.id ||
    typeof value.configVersion !== "string" ||
    !record(value.text) ||
    !record(value.image) ||
    !record(value.storage)
  )
    throw new Error("公司配置身份或版本不匹配。");
  const b = value as unknown as CompanyBootstrap;
  if (session.accountKind === "password" && (b.storage.enabled || b.image.credential || b.text.enabled && b.text.transport !== "proxy" || b.image.enabled && b.image.adapter !== "company-proxy"))
    throw new Error("访客账号能力配置无效。");
  if (
    (b.storage.audience && b.storage.audience !== "tuda-nas") ||
    (b.storage.scopes &&
      (!Array.isArray(b.storage.scopes) ||
        b.storage.scopes.some(
          (s) =>
            ![
              "boards:read",
              "boards:write",
              "assets:read",
              "assets:write",
            ].includes(s),
        )))
  )
    throw new Error("公司存储权限配置无效。");
  if (
    typeof b.text.enabled !== "boolean" ||
    typeof b.image.enabled !== "boolean" ||
    typeof b.storage.enabled !== "boolean" ||
    !Array.isArray(b.text.providers) ||
    !Array.isArray(b.image.models)
  )
    throw new Error("公司能力配置格式无效。");
  const ids = new Set<string>();
  for (const p of b.text.providers) {
    if (
      !p ||
      !/^[a-zA-Z0-9_-]+$/.test(p.id) ||
      typeof p.name !== "string" ||
      ![
        "anthropic-messages",
        "openai-responses",
        "openai-chat-completions",
      ].includes(p.protocol) ||
      !Array.isArray(p.models)
    )
      throw new Error("文本协议配置无效。");
    const url = new URL(p.baseUrl);
    if (
      url.origin !== origin ||
      url.pathname !== `${prefix}/proxy/tuda/${p.id}/v1` ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("文本代理地址不属于当前应用。");
    for (const m of p.models) {
      if (
        !m ||
        typeof m.id !== "string" ||
        !m.id ||
        typeof m.name !== "string" ||
        ids.has(`${p.id}/${m.id}`)
      )
        throw new Error("文本模型目录无效。");
      ids.add(`${p.id}/${m.id}`);
    }
  }
  if (b.text.enabled && (!b.text.defaultModel || !ids.has(b.text.defaultModel)))
    throw new Error("默认文本模型不在授权目录中。");
  if (!b.text.enabled && b.text.providers.length)
    throw new Error("禁用文本配置包含可用模型。");
  if (
    b.image.models.some(
      (m) => !(COMPANY_IMAGE_MODELS as readonly string[]).includes(m),
    )
  )
    throw new Error("生图模型不在批准目录中。");
  if (b.image.enabled) {
    if (b.image.adapter === "company-proxy") {
      if (session.accountKind !== "password" || b.image.credential || !b.image.models.length || b.storage.enabled || b.text.transport !== "proxy")
        throw new Error("访客媒体授权配置无效。");
      return b;
    }
    const c = b.image.credential;
    if (
      b.image.adapter !== "toapiscli" ||
      b.image.package !== "@petercjl/toapiscli" ||
      !b.image.models.length ||
      !c ||
      c.schemaVersion !== 1 ||
      !["cn", "com"].includes(c.site) ||
      typeof c.apiKey !== "string" ||
      !c.apiKey.trim() ||
      Object.keys(c).some(
        (k) => !["schemaVersion", "site", "apiKey", "label"].includes(k),
      )
    )
      throw new Error("ToAPIs 授权配置无效。");
  } else if (b.image.credential || b.image.models.length)
    throw new Error("禁用生图配置包含凭据或模型。");
  return b;
}

export interface AccountSnapshot {
  origin: string;
  session?: CompanySession;
  bootstrap?: CompanyBootstrap;
  directModels?: CompanyDirectModels;
}
/** No renderer or NAS access: this class owns the app/device grant and private bootstrap. */
export class CompanyAccount extends EventEmitter {
  private snapshot: AccountSnapshot;
  private pending?: {
    requestId: string;
    verifier: string;
    expires: number;
    interval: number;
    nextPoll: number;
    profileIdentity?: string;
  };
  private problem?: string;
  private refreshing?: Promise<void>;
  private modelController = new AbortController();
  private leaseUntil = 0;
  private nextModelCheck = 0;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private loggingOut = false;
  constructor(
    origin: string,
    private persist: (value: AccountSnapshot) => Promise<void>,
    private fetcher: typeof fetch = fetch,
  ) {
    super();
    this.snapshot = { origin: origin ? companyOrigin(origin) : "" };
  }
  get origin() {
    return this.snapshot.origin;
  }
  get authenticated() {
    return (
      !!this.snapshot.session &&
      Date.parse(this.snapshot.session.expiresAt) > Date.now()
    );
  }
  get session() {
    return this.authenticated ? this.snapshot.session : undefined;
  }
  get bootstrap() {
    return this.authenticated ? this.snapshot.bootstrap : undefined;
  }
  get directModels() {
    return this.authenticated && !this.loggingOut ? this.snapshot.directModels : undefined;
  }
  private invalidateText() {
    clearTimeout(this.leaseTimer);
    this.leaseUntil = 0;
    this.nextModelCheck = 0;
    this.modelController.abort(new Error("公司模型授权已失效或变更。"));
  }
  stopAuthorization() { this.invalidateText(); }
  private acceptLease(started: number) {
    clearTimeout(this.leaseTimer);
    if (this.modelController.signal.aborted) this.modelController = new AbortController();
    this.leaseUntil = Math.min(started + 300_000, Date.parse(this.session!.expiresAt));
    this.nextModelCheck = started + 120_000;
    this.leaseTimer = setTimeout(() => this.invalidateText(), Math.max(0, this.leaseUntil - Date.now()));
    this.leaseTimer.unref();
  }
  /** Pin each transport to a device, configuration and endpoint. No company Token reaches a provider. */
  textFetch(config: TextProviderConfig, modelFetch: typeof fetch = fetch): typeof fetch {
    const direct = this.directModels, token = this.session?.token;
    if (!direct || !token || config.transport !== "company-direct") throw new Error("请先刷新公司直连模型授权。");
    const p = directProvider(direct, config.id), base = new URL(p.options.baseURL);
    if (config.baseUrl !== p.options.baseURL) throw new Error("文本模型地址与直连授权不一致。");
    const pinnedVersion = direct.configVersion;
    return (async (input, init) => {
      const current = () => {
        if (this.loggingOut || this.session?.token !== token || this.directModels?.configVersion !== pinnedVersion)
          throw new Error("公司模型配置已更新，请重新发送本轮请求。");
      };
      current();
      if (Date.now() >= this.nextModelCheck || Date.now() >= this.leaseUntil) {
        try { await this.refresh(); } catch { if (Date.now() >= this.leaseUntil) throw new Error("公司模型授权续验失败，请检查网络或重新登录。"); }
      }
      current();
      if (Date.now() >= this.leaseUntil || this.modelController.signal.aborted) throw new Error("公司模型授权已过期。");
      const url = new URL(input instanceof Request ? input.url : String(input));
      const basePath = base.pathname.replace(/\/$/, "");
      if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(basePath + "/"))
        || url.username || url.password) throw new Error("模型请求偏离了已授权服务商地址。");
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("X-Company-App-Id");
      if (p.wire_api === "anthropic") { headers.delete("authorization"); headers.set("x-api-key", p.options.apiKey); }
      else { headers.delete("x-api-key"); headers.set("authorization", `Bearer ${p.options.apiKey}`); }
      installModelNetworkAudit();
      return withModelTrace({model:true,providerId:config.id}, () => modelFetch(input, { ...init, headers, redirect: "error",
        signal: AbortSignal.any([this.modelController.signal, ...(init?.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])]) }));
    }) as typeof fetch;
  }
  get status(): CompanyAccountPublicStatus {
    const b = this.bootstrap,
      s = this.session;
    return {
      origin: this.origin,
      authenticated: this.authenticated,
      member: s?.member,
      organization: s?.organization,
      configVersion: b?.configVersion,
      textModels: b?.text.enabled
        ? b.text.providers.reduce((n, p) => n + p.models.length, 0)
        : 0,
      imageModels: b?.image.enabled ? b.image.models.length : 0,
      imageReason: b?.image.reason,
      error: this.problem,
    };
  }
  private changed() {
    this.emit("state", this.status);
  }
  async restore(value: AccountSnapshot) {
    if (companyOrigin(value.origin) !== this.origin) return;
    if (value.session) this.checkSession(value.session);
    if (value.session?.accountKind === "password" && value.directModels) throw new Error("访客账号不接受直连凭据。");
    if (value.bootstrap && value.session)
      validateBootstrap(value.bootstrap, value.session, this.origin);
    if (value.directModels && value.session) validateDirectModels(value.directModels, value.session, this.origin);
    this.invalidateText();
    this.snapshot = value;
    if (!this.authenticated) this.snapshot = { origin: this.origin };
    this.changed();
  }
  async configure(origin: string, persist = true) {
    this.invalidateText();
    this.snapshot = { origin: companyOrigin(origin) };
    this.pending = undefined;
    this.problem = undefined;
    if (persist) await this.persist(this.snapshot);
    this.changed();
  }
  private checkSession(s: CompanySession) {
    if (
      s.contract !== 1 ||
      s.appId !== "tuda" ||
      typeof s.token !== "string" ||
      !s.token ||
      typeof s.sessionId !== "string" ||
      !s.sessionId ||
      !Number.isFinite(Date.parse(s.expiresAt)) ||
      !identity(s.member) ||
      !identity(s.organization)
    )
      throw new Error("公司设备授权格式无效。");
  }
  /** Main-process-only, app-bound PKCE exchange. Never returns credentials. */
  async acceptHostHandoff(value: unknown) {
    if (!record(value) || value.contract !== 1 || value.appId !== "tuda" ||
      value.origin !== this.origin || !this.origin ||
      typeof value.code !== "string" || !opaque.test(value.code) ||
      typeof value.verifier !== "string" || !opaque.test(value.verifier) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 120_000) {
      throw new Error("AUTH_HANDOFF_INVALID");
    }
    const previous = this.snapshot;
    try {
      const data = await this.request("/handoff/exchange", { appId: "tuda", code: value.code, verifier: value.verifier }, false);
      if (data.status !== "authorized") throw new Error("AUTH_HANDOFF_INVALID");
      const session = data as unknown as CompanySession;
      this.checkSession(session);
      if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("AUTH_HANDOFF_EXPIRED");
      this.invalidateText();
      this.snapshot = { origin: this.origin, session };
      this.pending = undefined;
      await this.refresh();
      return { authenticated: true, memberId: session.member.id, organizationId: session.organization.id };
    } catch {
      this.snapshot = previous;
      await this.persist(previous);
      this.changed();
      throw new Error("AUTH_HANDOFF_FAILED");
    }
  }
  private async request(
    route: string,
    body?: unknown,
    authenticated = true,
  ): Promise<Record<string, unknown>> {
    if (!this.origin) throw new Error("请配置公网公司账号服务。");
    if (authenticated && !this.authenticated)
      throw new Error("请使用公司钉钉重新登录。");
    const requestSession = this.session, requestOrigin = this.origin;
    const response = await this.fetcher(requestOrigin + prefix + route, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "X-Company-App-Id": "tuda",
        ...(authenticated
          ? { authorization: `Bearer ${requestSession!.token}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      const failure = error as { name?: string; code?: unknown; cause?: { code?: unknown }; message?: string };
      const rawCode = failure?.cause?.code ?? failure?.code;
      const networkCode = typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(rawCode) ? rawCode : undefined;
      const chromiumCode = typeof failure?.message === "string" ? /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(failure.message)?.[1] : undefined;
      const timeout = failure?.name === "TimeoutError" || networkCode === "UND_ERR_CONNECT_TIMEOUT" || chromiumCode === "ERR_TIMED_OUT";
      throw Object.assign(new Error(timeout ? "连接账号服务超时，请检查网络后重试。" : "账号服务连接失败，请检查网络或系统代理后重试。"), {
        code: "COMPANY_NETWORK_UNAVAILABLE", networkCode: networkCode ?? chromiumCode ?? (timeout ? "TIMEOUT" : "UNKNOWN")
      });
    });
    if (this.origin !== requestOrigin || (authenticated && this.session?.token !== requestSession?.token))
      throw Object.assign(new Error("公司账号已切换，忽略旧请求。"), {code:"ACCOUNT_CHANGED"});
    const envelope: unknown = await response.json().catch(() => undefined);
    const code =
      record(envelope) &&
      record(envelope.error) &&
      typeof envelope.error.code === "string" &&
      /^[A-Z_]{1,80}$/.test(envelope.error.code)
        ? envelope.error.code
        : undefined;
    if (
      response.status === 401 ||
      (response.status === 403 &&
        authenticated &&
        (route !== "/storage/token" ||
          code === "ACCESS_DENIED" ||
          code === "APP_MISMATCH"))
    ) {
      this.invalidateText();
      this.snapshot = { origin: this.origin };
      await this.persist(this.snapshot);
      this.changed();
    }
    // Error bodies are untrusted and may contain private upstream information.
    if (!response.ok)
      throw Object.assign(
        new Error(
          route === "/auth/password"
            ? response.status === 429 ? "登录尝试过多，请稍后重试。" : "账号或密码不正确，或账号已停用。"
          : route === "/storage/token"
            ? `公司存储授权不可用（HTTP ${response.status}），请检查存储权限或选择本地空间。`
            : `公司授权请求失败（HTTP ${response.status}），请重新登录或联系管理员。`,
        ),
        { code, status: response.status },
      );
    if (!record(envelope) || envelope.ok !== true || !record(envelope.data))
      throw new Error("公司服务响应格式无效。");
    const data = envelope.data;
    if (data.contract !== (route === "/direct-models" ? 2 : 1) || data.appId !== "tuda")
      throw new Error("公司接口版本或应用不匹配。");
    return data;
  }
  async beginLogin(refreshProfile = false) {
    const verifier = randomBytes(32).toString("base64url");
    const d = await this.request(
      "/auth/start",
      {
        appId: "tuda",
        ...(refreshProfile ? {refreshProfile: true} : {}),
        verifierHash: createHash("sha256").update(verifier).digest("hex"),
      },
      false,
    );
    if (
      typeof d.requestId !== "string" ||
      !opaque.test(d.requestId) ||
      typeof d.verificationUrl !== "string" ||
      typeof d.expiresIn !== "number" ||
      d.expiresIn <= 0 ||
      d.expiresIn > 600 ||
      typeof d.intervalMs !== "number" ||
      d.intervalMs < 1000 ||
      d.intervalMs > 30_000 ||
      d.userCode !== d.requestId.slice(0, 8).toUpperCase()
    )
      throw new Error("公司授权请求无效。");
    const url = new URL(d.verificationUrl);
    if (
      url.origin !== this.origin ||
      url.pathname !== prefix + "/auth/authorize" ||
      url.searchParams.get("request") !== d.requestId ||
      [...url.searchParams.keys()].some(key => key !== "request" && !(refreshProfile && key === "refreshProfile" && url.searchParams.get(key) === "1")) ||
      url.searchParams.getAll("request").length !== 1 ||
      url.searchParams.getAll("refreshProfile").length > 1 ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("公司授权页面地址无效。");
    this.pending = {
      requestId: d.requestId,
      verifier,
      expires: Date.now() + d.expiresIn * 1000,
      interval: d.intervalMs,
      nextPoll: Date.now() + d.intervalMs,
      ...(refreshProfile && this.session ? {profileIdentity: `${this.session.organization.id}:${this.session.member.id}`} : {}),
    };
    return {
      authorizeUrl: url.href,
      expiresAt: new Date(this.pending.expires).toISOString(),
      intervalMs: d.intervalMs,
      userCode: d.userCode,
    };
  }
  async passwordLogin(username: string, password: string) {
    if (this.authenticated) throw new Error("请先退出当前账号。");
    const data = await this.request("/auth/password", { appId: "tuda", username, password }, false);
    if (data.status !== "authorized" || data.accountKind !== "password") throw new Error("账号登录响应无效。");
    const session = data as unknown as CompanySession;
    this.checkSession(session);
    this.invalidateText(); this.pending = undefined;
    this.snapshot = { origin: this.origin, session };
    await this.persist(this.snapshot);
    await this.refresh();
    this.changed();
    return { status: "authorized" as const };
  }
  async guestImage(input: { requestId: string; model: string; prompt: string; resolution: string; aspect: string; references: Array<{ mimeType: string; base64: string }> }) {
    const session = this.session;
    if (session?.accountKind !== "password" || this.bootstrap?.image.adapter !== "company-proxy") throw new Error("访客媒体授权不可用。");
    let job = await this.request("/image/jobs", input);
    const id = job.id;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("媒体任务响应无效。");
    const deadline = Date.now() + 15 * 60_000;
    while (job.state !== "succeeded") {
      if (job.state === "failed") throw new Error(`生图任务失败，请保留任务 ${id}。`);
      if (Date.now() > deadline) throw new Error(`生图等待超时，请通过原请求恢复任务 ${id}。`);
      await new Promise(resolve => setTimeout(resolve, 2500));
      job = await this.request("/image/jobs/" + id);
    }
    if (!Number.isSafeInteger(job.assetCount) || Number(job.assetCount) < 1 || Number(job.assetCount) > 8) throw new Error("媒体素材响应无效。");
    const images = [];
    for (let i = 0; i < Number(job.assetCount); i++) {
      if (this.session?.token !== session.token) throw new Error("账号已切换。");
      const response = await this.fetcher(this.origin + prefix + `/image/jobs/${id}/assets/${i}`, {
        headers: { authorization: `Bearer ${session.token}`, "X-Company-App-Id": "tuda" }, redirect: "error", signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok || Number(response.headers.get("content-length")) > 40 * 1024 * 1024) throw new Error("媒体素材下载失败。");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (this.session?.token !== session.token || bytes.length > 40 * 1024 * 1024) throw new Error("媒体素材下载无效。");
      const mimeType = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP" ? "image/webp" : undefined;
      if (!mimeType) throw new Error("媒体产物不是有效图片。");
      images.push({ bytes, mimeType });
    }
    return { images };
  }
  async pollLogin(): Promise<{ status: "pending" | "authorized" }> {
    const p = this.pending;
    if (!p || Date.now() > p.expires)
      throw new Error("登录请求已过期，请重新发起。");
    if (Date.now() < p.nextPoll) return { status: "pending" };
    p.nextPoll = Date.now() + p.interval;
    let d: Record<string, unknown>;
    try {
      d = await this.request(
        "/auth/poll",
        { appId: "tuda", requestId: p.requestId, verifier: p.verifier },
        false,
      );
    } catch (error) {
      this.pending = undefined;
      throw error;
    }
    if (d.status === "pending") return { status: "pending" };
    if (d.status !== "authorized") throw new Error("公司授权状态无效。");
    const session = d as unknown as CompanySession;
    this.checkSession(session);
    if (p.profileIdentity && p.profileIdentity !== `${session.organization.id}:${session.member.id}`) {
      this.pending = undefined;
      throw new Error("刷新资料时请使用当前登录的钉钉账号。");
    }
    this.pending = undefined;
    this.invalidateText();
    this.snapshot = { origin: this.origin, session };
    await this.persist(this.snapshot);
    await this.refresh();
    this.changed();
    return { status: "authorized" };
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    const initialSession = this.session;
    const started = Date.now();
    this.refreshing = (async () => {
      try {
        const d = await this.request("/session");
        const s = initialSession!;
        if (
          d.authenticated !== true ||
          d.sessionId !== s.sessionId ||
          !identity(d.member) ||
          (d.member as { id: string }).id !== s.member.id ||
          !identity(d.organization) ||
          (d.organization as { id: string }).id !== s.organization.id
        )
          throw new Error("公司会话身份不匹配。");
        const bootstrap = validateBootstrap(
          await this.request("/bootstrap"),
          s,
          this.origin,
        );
        let directModels: CompanyDirectModels | undefined;
        if (bootstrap.text.transport === "proxy" && (s.accountKind !== "password" || bootstrap.storage.enabled)) throw new Error("访客代理授权无效。");
        if (bootstrap.text.enabled && bootstrap.text.transport !== "proxy") {
          if (!directDigest(d.subject) || !directDigest(d.configVersion) || !record(d.authorization)
            || d.authorization.validForSeconds !== 300 || d.authorization.refreshAfterSeconds !== 120)
            throw new Error("公司服务尚未提供 Tuda 直连授权续验契约。");
          directModels = validateDirectModels(await this.request("/direct-models"), s, this.origin, d.subject, d.configVersion);
        }
        if (this.session?.token !== s.token || this.loggingOut) throw new Error("公司登录已变更。");
        if (this.snapshot.directModels?.configVersion !== directModels?.configVersion) this.invalidateText();
        // Profile data can change while the app-bound identity remains the same.
        this.snapshot = { ...this.snapshot, session: { ...s, member: bootstrap.member, organization: bootstrap.organization }, bootstrap, directModels };
        this.problem = undefined;
        await this.persist(this.snapshot);
        if (directModels) this.acceptLease(started);
      } catch (error) {
        if (this.session && this.session.token !== initialSession?.token) throw error;
        const problem = error as {code?: string; status?: number};
        const temporary = problem.code === "COMPANY_NETWORK_UNAVAILABLE" || (problem.status ?? 0) >= 500 || problem.status === 429;
        if (!temporary || Date.now() >= this.leaseUntil) this.invalidateText();
        else this.nextModelCheck = Math.min(Date.now() + 10_000, this.leaseUntil);
        this.problem =
          error instanceof Error ? error.message : "公司配置刷新失败。";
        throw error;
      } finally {
        this.changed();
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  async logout() {
    this.loggingOut = true;
    this.invalidateText();
    let confirmed = false;
    try {
      if (this.authenticated) {
        await this.request("/logout", {});
        confirmed = true;
      }
    } finally {
      this.snapshot = { origin: this.origin };
      this.pending = undefined;
      this.loggingOut = false;
      await this.persist(this.snapshot);
      this.problem = confirmed
        ? undefined
        : "已退出本机；远端会话撤销尚未确认。";
      this.changed();
    }
  }
  async storageToken() {
    const storage = this.bootstrap?.storage;
    if (!storage?.enabled)
      throw new Error(
        "当前账号未获 NAS 存储授权，可选择本地空间继续工作。",
      );
    const scopes = storage.scopes ?? ["boards:read", "assets:read"];
    if (!scopes.includes("boards:read"))
      throw new Error("当前账号无权查看 NAS 画板，可选择本地空间。");
    const d = await this.request("/storage/token", {
      audience: "tuda-nas",
      scopes,
    });
    if (
      typeof d.token !== "string" ||
      !d.token ||
      d.tokenType !== "Bearer" ||
      d.audience !== "tuda-nas" ||
      d.organizationId !== this.session?.organization.id ||
      d.memberId !== this.session?.member.id ||
      typeof d.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(d.expiresAt)) ||
      Date.parse(d.expiresAt) <= Date.now() ||
      Date.parse(d.expiresAt) > Date.now() + 301_000 ||
      !Array.isArray(d.scopes) ||
      !d.scopes.includes("boards:read") ||
      d.scopes.some(
        (s) =>
          ![
            "boards:read",
            "boards:write",
            "assets:read",
            "assets:write",
          ].includes(String(s)) || !scopes.includes(String(s)),
      )
    )
      throw new Error("NAS 存储授权格式无效。");
    return {
      token: d.token,
      expiresAt: d.expiresAt,
      scopes: d.scopes as string[],
    };
  }
}
