import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import type {
  CompanyAccountPublicStatus,
  CompanyBootstrap,
  CompanySession,
} from "../../shared/company-account.js";
import { COMPANY_IMAGE_MODELS } from "../../shared/company-account.js";

const prefix = "/api/company/v1";
const opaque = /^[A-Za-z0-9_-]{43}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown) =>
  record(v) && typeof v.id === "string" && !!v.id && typeof v.name === "string";
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
  };
  private problem?: string;
  private refreshing?: Promise<void>;
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
    if (value.bootstrap && value.session)
      validateBootstrap(value.bootstrap, value.session, this.origin);
    this.snapshot = value;
    if (!this.authenticated) this.snapshot = { origin: this.origin };
    this.changed();
  }
  async configure(origin: string, persist = true) {
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
  private async request(
    route: string,
    body?: unknown,
    authenticated = true,
  ): Promise<Record<string, unknown>> {
    if (!this.origin) throw new Error("请配置公网公司账号服务。");
    if (authenticated && !this.authenticated)
      throw new Error("请使用公司钉钉重新登录。");
    const response = await this.fetcher(this.origin + prefix + route, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "X-Company-App-Id": "tuda",
        ...(authenticated
          ? { authorization: `Bearer ${this.session!.token}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
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
      this.snapshot = { origin: this.origin };
      await this.persist(this.snapshot);
      this.changed();
    }
    // Error bodies are untrusted and may contain private upstream information.
    if (!response.ok)
      throw Object.assign(
        new Error(
          route === "/storage/token"
            ? `公司存储授权不可用（HTTP ${response.status}），请检查存储权限或选择公司本地文件夹。`
            : `公司授权请求失败（HTTP ${response.status}），请重新登录或联系管理员。`,
        ),
        { code },
      );
    if (!record(envelope) || envelope.ok !== true || !record(envelope.data))
      throw new Error("公司服务响应格式无效。");
    const data = envelope.data;
    if (data.contract !== 1 || data.appId !== "tuda")
      throw new Error("公司接口版本或应用不匹配。");
    return data;
  }
  async beginLogin() {
    const verifier = randomBytes(32).toString("base64url");
    const d = await this.request(
      "/auth/start",
      {
        appId: "tuda",
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
      [...url.searchParams.keys()].length !== 1 ||
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
    };
    return {
      authorizeUrl: url.href,
      expiresAt: new Date(this.pending.expires).toISOString(),
      intervalMs: d.intervalMs,
      userCode: d.userCode,
    };
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
    this.pending = undefined;
    this.snapshot = { origin: this.origin, session };
    await this.persist(this.snapshot);
    await this.refresh();
    this.changed();
    return { status: "authorized" };
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const d = await this.request("/session");
        const s = this.session!;
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
        this.snapshot = { ...this.snapshot, bootstrap };
        this.problem = undefined;
        await this.persist(this.snapshot);
      } catch (error) {
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
    let confirmed = false;
    try {
      if (this.authenticated) {
        await this.request("/logout", {});
        confirmed = true;
      }
    } finally {
      this.snapshot = { origin: this.origin };
      this.pending = undefined;
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
        "当前账号未获 NAS 存储授权，可选择公司本地文件夹继续工作。",
      );
    const scopes = storage.scopes ?? ["boards:read", "assets:read"];
    if (!scopes.includes("boards:read"))
      throw new Error("当前账号无权查看 NAS 画板，可选择公司本地文件夹。");
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
