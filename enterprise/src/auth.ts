import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { EnterpriseMember, EnterpriseSession } from "../../shared/enterprise.js";
import type { ServerConfig } from "./config.js";
import { fail, ServiceError } from "./config.js";
import { Database } from "./database.js";

export const hash = (input: string) => createHash("sha256").update(input).digest("hex");
export interface Identity { corpId: string; userId: string; unionId: string; name: string }
export interface DingTalkIdentityProvider { exchange(code: string): Promise<Identity> }
export interface Principal extends EnterpriseMember { orgId: string; unionId: string; storageScopes?: string[] }

export class DingTalkProvider implements DingTalkIdentityProvider {
  constructor(private config: ServerConfig, private fetcher: typeof fetch = fetch) {}
  private async call(url: string, body?: unknown, token?: string): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { "x-acs-dingtalk-access-token": token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || (result.errcode && Number(result.errcode) !== 0)) fail(502, "DINGTALK_REQUEST_FAILED", "钉钉身份核验失败，请检查应用权限或稍后重试。");
    return result;
  }
  async exchange(code: string): Promise<Identity> {
    const result = await this.call("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
      clientId: this.config.clientId, clientSecret: this.config.clientSecret, code, grantType: "authorization_code"
    });
    // scope=openid corpid returns the selected organization. Missing organization fails closed.
    if (!this.config.corpId || result.corpId !== this.config.corpId) fail(403, "ORGANIZATION_DENIED", "请使用指定企业的钉钉组织登录。");
    if (typeof result.accessToken !== "string") fail(502, "DINGTALK_TOKEN_INVALID", "钉钉用户授权无效。");
    const profile = await this.call("https://api.dingtalk.com/v1.0/contact/users/me", undefined, result.accessToken);
    if (typeof profile.unionId !== "string") fail(403, "IDENTITY_INVALID", "无法确认钉钉身份。");
    return { corpId: result.corpId, userId: "dt_" + hash(profile.unionId).slice(0, 24), unionId: profile.unionId, name: String(profile.nick || profile.name || "企业成员").slice(0, 100) };
  }

}

export class AuthService {
  constructor(readonly db: Database, readonly config: ServerConfig, readonly identity: DingTalkIdentityProvider = new DingTalkProvider(config)) {}
  get configured() { return Boolean(this.config.corpId && this.config.clientId && this.config.clientSecret); }
  private encrypt(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.config.masterKey, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  private decrypt(value: string): EnterpriseSession {
    const raw = Buffer.from(value, "base64"), cipher = createDecipheriv("aes-256-gcm", this.config.masterKey, raw.subarray(0, 12));
    cipher.setAuthTag(raw.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString());
  }
  async begin() {
    if (!this.configured) fail(503, "DINGTALK_NOT_CONFIGURED", "企业钉钉登录尚未配置，请联系管理员。");
    const id = randomUUID(), state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    await this.db.pool.query("INSERT INTO tuda_logins(id,state_hash,verifier_hash,expires_at) VALUES($1,$2,$3,$4)", [id, hash(state), hash(verifier), expiresAt]);
    const url = new URL("https://login.dingtalk.com/oauth2/auth");
    url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: "code", scope: "openid corpid", prompt: "consent", state,
      redirect_uri: this.config.publicUrl + "/auth/dingtalk/callback" }).toString();
    return { loginId: id, verifier, expiresAt, authorizeUrl: url.toString() };
  }
  async callback(state: string, code: string) {
    if (!state || !code || state.length > 200 || code.length > 2048) fail(400, "INVALID_CALLBACK", "登录回调无效。");
    const claimed = await this.db.pool.query("UPDATE tuda_logins SET used=true WHERE state_hash=$1 AND expires_at>now() AND used=false RETURNING id", [hash(state)]);
    if (!claimed.rowCount) fail(400, "LOGIN_EXPIRED", "登录请求已使用或过期，请重新登录。");
    const id = claimed.rows[0].id;
    try {
      const identity = await this.identity.exchange(code);
      if (identity.corpId !== this.config.corpId) fail(403, "ORGANIZATION_DENIED", "此账号不属于指定企业。");
      await this.db.transaction(async client => {
        const role = (this.config.adminIds.includes(identity.userId) || this.config.adminUnionId === identity.unionId) ? "admin" : this.config.defaultRole;
        const member = await client.query(`INSERT INTO tuda_members(org_id,user_id,union_id,name,role) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(org_id,user_id) DO UPDATE SET name=excluded.name,union_id=excluded.union_id,checked_at=now() RETURNING role,active`,
          [this.config.organizationId, identity.userId, identity.unionId, identity.name, role]);
        if (!member.rows[0].active) fail(403, "MEMBERSHIP_REVOKED", "此账号的企业访问权限已被撤销。");
        const session = await this.issue(client, { id: identity.userId, name: identity.name, role: member.rows[0].role, orgId: this.config.organizationId, unionId: identity.unionId });
        await client.query("UPDATE tuda_logins SET result=$2 WHERE id=$1", [id, this.encrypt(session)]);
      });
    } catch (error) {
      const message = error instanceof ServiceError ? error.message : "钉钉登录失败，请检查应用配置。";
      await this.db.pool.query("UPDATE tuda_logins SET error=$2 WHERE id=$1", [id, message]);
      throw error;
    }
  }
  async poll(loginId: string, verifier: string) {
    if (!/^[0-9a-f-]{36}$/i.test(loginId) || verifier.length < 32 || verifier.length > 200) fail(400, "INVALID_LOGIN", "登录请求无效。");
    const result = await this.db.pool.query("SELECT * FROM tuda_logins WHERE id=$1 AND expires_at>now()", [loginId]);
    const login = result.rows[0];
    if (!login || !timingSafeEqual(Buffer.from(login.verifier_hash), Buffer.from(hash(verifier)))) fail(401, "LOGIN_EXPIRED", "登录请求已过期。");
    if (login.error) fail(403, "LOGIN_DENIED", login.error);
    return login.result ? { status: "authorized", session: this.decrypt(login.result) } : { status: "pending" };
  }
  async issue(client: PoolClient, user: Principal): Promise<EnterpriseSession> {
    const token = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + 12 * 3600_000).toISOString();
    await client.query("INSERT INTO tuda_sessions(token_hash,org_id,user_id,expires_at) VALUES($1,$2,$3,$4)", [hash(token), user.orgId, user.id, expiresAt]);
    return { token, expiresAt, organizationId: user.orgId, organizationName: this.config.organizationName, user: { id: user.id, name: user.name, role: user.role } };
  }
  async authenticate(token: string): Promise<Principal> {
    if (!token || token.length > 200) fail(401, "SESSION_REQUIRED", "请先登录企业空间。");
    const query = await this.db.pool.query(`SELECT m.* FROM tuda_sessions s JOIN tuda_members m ON m.org_id=s.org_id AND m.user_id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND m.active=true AND m.org_id=$2`, [hash(token), this.config.organizationId]);
    const member = query.rows[0];
    if (!member) fail(401, "SESSION_EXPIRED", "企业登录已过期或权限已撤销。");
    return { id: member.user_id, name: member.name, role: member.role, orgId: member.org_id, unionId: member.union_id };
  }
  async logout(token: string) { await this.db.pool.query("DELETE FROM tuda_sessions WHERE token_hash=$1", [hash(token)]); }
}
