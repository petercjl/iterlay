import { fail, type ServerConfig } from "./config.js";
import type { Principal } from "./auth.js";
/** The NAS receives a short-lived storage grant; model/device tokens are never accepted here. */
export class CompanyStorageAuth {
  constructor(
    private config: ServerConfig,
    private fetcher: typeof fetch = fetch,
  ) {}
  async authenticate(token: string): Promise<Principal> {
    const c = this.config;
    if (!c.companyOrigin || !c.companyServiceToken || !c.companyOrganizationId)
      fail(503, "STORAGE_AUTH_NOT_CONFIGURED", "NAS 公司存储授权尚未配置。");
    const origin = new URL(c.companyOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      fail(503, "STORAGE_AUTH_NOT_CONFIGURED", "NAS 公司存储授权地址无效。");
    let response: Response;
    try {
      response = await this.fetcher(
        origin.origin + "/api/company/v1/storage/introspect",
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${c.companyServiceToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      fail(
        503,
        "STORAGE_AUTH_UNAVAILABLE",
        "暂时无法验证 NAS 存储授权，请使用公司本地文件夹。",
      );
    }
    if (response.status === 429)
      fail(429, "STORAGE_AUTH_RATE_LIMITED", "存储授权服务繁忙，请稍后重试保存；当前修改尚未保存到 NAS。");
    if (response.status === 401 || response.status === 403)
      fail(503, "STORAGE_AUTH_SERVICE_REJECTED", "NAS 服务身份验证失败，请联系管理员检查存储服务配置。");
    if (!response.ok)
      fail(503, "STORAGE_AUTH_UNAVAILABLE", `存储授权服务暂时不可用（HTTP ${response.status}），请稍后重试保存。`);
    const envelope = (await response.json()) as {
      ok?: boolean;
      data?: {
        contract?: number;
        active?: boolean;
        appId?: string;
        audience?: string;
        organizationId?: string;
        memberId?: string;
        sessionId?: string;
        scopes?: string[];
        expiresAt?: string;
      };
    };
    const d = envelope.data;
    if (
      !envelope.ok ||
      !d ||
      d.contract !== 1 ||
      !d.active ||
      d.appId !== "tuda" ||
      d.audience !== "tuda-nas" ||
      d.organizationId !== c.companyOrganizationId ||
      typeof d.memberId !== "string" ||
      !d.memberId ||
      typeof d.sessionId !== "string" ||
      !Array.isArray(d.scopes) ||
      d.scopes.some(
        (s) =>
          ![
            "boards:read",
            "boards:write",
            "assets:read",
            "assets:write",
          ].includes(s),
      ) ||
      !d.expiresAt ||
      !Number.isFinite(Date.parse(d.expiresAt)) ||
      Date.parse(d.expiresAt) <= Date.now() ||
      Date.parse(d.expiresAt) > Date.now() + 301_000
    )
      fail(401, "STORAGE_GRANT_INVALID", "NAS 存储授权已过期或不可用。");
    return {
      id: d.memberId,
      name: "企业成员",
      role: d.scopes.includes("boards:write") ? "editor" : "viewer",
      orgId: c.organizationId,
      unionId: "company:" + d.memberId,
      storageScopes: d.scopes,
    };
  }
}
export function requireStorageScope(user: Principal, scope: string) {
  if (user.storageScopes && !user.storageScopes.includes(scope))
    fail(403, "STORAGE_SCOPE_DENIED", "当前存储授权不允许此操作。");
}
export function commandStorageScopes(channel: string): string[] {
  if (channel.startsWith("boards:"))
    return [
      "boards:read",
      ...([
        "boards:list",
        "boards:get",
        "boards:getState",
        "boards:library:get",
        "boards:setLastOpened",
        "boards:trash:list",
        "boards:images:trash:list",
      ].includes(channel)
        ? []
        : ["boards:write"]),
    ];
  if (channel === "asset:importUpload") return ["assets:write"];
  if (channel.startsWith("asset:")) return ["assets:read"];
  if (channel.startsWith("assets:")) return ["boards:read", "assets:read"];
  fail(403, "STORAGE_OPERATION_DENIED", "存储授权仅供画板和素材操作。");
}
