import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Principal } from "./auth.js";
import { Database } from "./database.js";
import { fail, type ServerConfig } from "./config.js";

export interface ProviderAccount { baseUrl: string; model: string; apiKey: string }
export type ProviderKind = "image" | "text";

/** Account assignment belongs to Tuda; provider credentials never enter desktop responses. */
export class ProvidersService {
  constructor(private db: Database, private config: ServerConfig) {}
  private scope(org: string, user: string, kind: ProviderKind) { return `${org}:${user}:${kind}`; }
  seal(value: ProviderAccount, scope: string) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.config.masterKey, iv);
    cipher.setAAD(Buffer.from(scope));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  }
  unseal(value: string, scope: string): ProviderAccount {
    const raw = Buffer.from(value, "base64"), cipher = createDecipheriv("aes-256-gcm", this.config.masterKey, raw.subarray(0, 12));
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(raw.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString());
  }
  async resolve(orgId: string, userId: string, kind: ProviderKind): Promise<ProviderAccount | null> {
    const row = await this.db.pool.query("SELECT secret FROM tuda_provider_accounts WHERE org_id=$1 AND user_id=$2 AND kind=$3", [orgId, userId, kind]);
    if (row.rowCount) return row.rows[0].secret ? this.unseal(row.rows[0].secret, this.scope(orgId, userId, kind)) : null;
    const prefix = kind === "image" ? { baseUrl: this.config.imageBaseUrl, model: this.config.imageModel, apiKey: this.config.imageApiKey } : { baseUrl: this.config.textBaseUrl, model: this.config.textModel, apiKey: this.config.textApiKey };
    return prefix.baseUrl && prefix.model && prefix.apiKey ? prefix : null;
  }
  async metadata(orgId: string, userId: string) {
    const image = await this.resolve(orgId, userId, "image"), text = await this.resolve(orgId, userId, "text");
    return { image: Boolean(image), imageModel: image?.model ?? "", text: Boolean(text), textModel: text?.model ?? "" };
  }
  async read(admin: Principal, userId: string) {
    if (admin.role !== "admin") fail(403, "ADMIN_REQUIRED", "需要管理员权限。");
    return Object.fromEntries(await Promise.all((["image", "text"] as const).map(async kind => {
      const value = await this.resolve(admin.orgId, userId, kind);
      return [kind, { enabled: Boolean(value), baseUrl: value?.baseUrl ?? "", model: value?.model ?? "", hasKey: Boolean(value?.apiKey) }];
    })));
  }
  async assign(admin: Principal, input: { userId: string; kind: ProviderKind; enabled: boolean; baseUrl?: string; model?: string; apiKey?: string }) {
    if (admin.role !== "admin") fail(403, "ADMIN_REQUIRED", "需要管理员权限。");
    if (!["image", "text"].includes(input.kind) || typeof input.enabled !== "boolean" || typeof input.userId !== "string") fail(400, "INVALID_PROVIDER", "服务分配参数无效。");
    const target = await this.db.pool.query("SELECT user_id FROM tuda_members WHERE org_id=$1 AND user_id=$2", [admin.orgId, input.userId]);
    if (!target.rowCount) fail(404, "MEMBER_NOT_FOUND", "企业成员不存在。");
    let secret: string | null = null;
    if (input.enabled) {
      const previous = await this.resolve(admin.orgId, input.userId, input.kind);
      let url: URL; try { url = new URL(input.baseUrl ?? previous?.baseUrl ?? ""); } catch { fail(400, "INVALID_PROVIDER", "请输入完整的模型服务地址。"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(400, "INVALID_PROVIDER", "模型服务地址格式无效。");
      const model = input.model?.trim() || previous?.model || "", apiKey = input.apiKey?.trim() || previous?.apiKey || "";
      if (!model || model.length > 200 || !apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) fail(400, "INVALID_PROVIDER", "请配置有效的模型与 API Key。");
      secret = this.seal({ baseUrl: url.toString().replace(/\/$/, ""), model, apiKey }, this.scope(admin.orgId, input.userId, input.kind));
    }
    await this.db.transaction(async client => {
      await client.query("INSERT INTO tuda_provider_accounts(org_id,user_id,kind,secret) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,user_id,kind) DO UPDATE SET secret=excluded.secret,updated_at=now()", [admin.orgId, input.userId, input.kind, secret]);
      await client.query("INSERT INTO tuda_audit(org_id,user_id,action,target) VALUES($1,$2,'provider:assign',$3)", [admin.orgId, admin.id, `${input.userId}:${input.kind}`]);
    });
    return { ok: true };
  }
}
