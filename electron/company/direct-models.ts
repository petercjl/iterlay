import type { CompanyDirectModels, CompanySession } from "../../shared/company-account.js";
import type { TextProviderConfig } from "../../shared/types.js";

const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
export const directDigest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export function validateDirectModels(value: unknown, session: CompanySession, origin: string, subject?: string, configVersion?: string): CompanyDirectModels {
  if (!record(value) || value.contract !== 2 || value.appId !== "tuda" || value.sessionId !== session.sessionId
    || value.authenticated !== true || !record(value.member) || value.member.id !== session.member.id
    || !record(value.organization) || value.organization.id !== session.organization.id
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) > Date.parse(session.expiresAt)
    || value.transport !== "direct" || !directDigest(value.subject) || !directDigest(value.configVersion)
    || (subject !== undefined && value.subject !== subject) || (configVersion !== undefined && value.configVersion !== configVersion)
    || typeof value.model !== "string" || !record(value.provider) || !Object.keys(value.provider).length) {
    throw new Error("公司直连模型配置的身份、版本或契约无效。");
  }
  const d = value as unknown as CompanyDirectModels;
  const models = new Set<string>();
  for (const [id, p] of Object.entries(d.provider)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !record(p) || typeof p.name !== "string"
      || !["anthropic", "responses", "chat"].includes(p.wire_api) || !record(p.options) || !record(p.models)
      || typeof p.options.baseURL !== "string" || typeof p.options.apiKey !== "string" || !p.options.apiKey.trim()
      || p.options.apiKey.length > 16_384 || /^(cow_|cdev_|csto_)/.test(p.options.apiKey)) throw new Error("公司直连模型协议或凭据无效。");
    const url = new URL(p.options.baseURL);
    if (url.protocol !== "https:" || url.origin === origin || url.username || url.password || url.hash || url.search
      || /\/api\/(company|codex-own)\//.test(url.pathname)) throw new Error("直连模型地址必须是服务商 HTTPS 端点。");
    for (const [model, m] of Object.entries(p.models)) {
      if (!model || !record(m) || typeof m.name !== "string" || !record(m.limit)
        || !Number.isSafeInteger(m.limit.context) || m.limit.context <= 0 || m.limit.context > 10_000_000
        || !Number.isSafeInteger(m.limit.output) || m.limit.output <= 0 || m.limit.output > m.limit.context) throw new Error("公司直连模型目录无效。");
      models.add(`${id}/${model}`);
    }
  }
  if (!models.has(d.model)) throw new Error("默认直连模型不在授权目录中。");
  return d;
}

export function directTextProviders(d: CompanyDirectModels): TextProviderConfig[] {
  return Object.entries(d.provider).flatMap(([id, p]) => Object.entries(p.models).map(([model, m]) => ({
    id: `company-text/${id}/${model}`, name: m.name, connectionName: p.name, type: "openai-compatible" as const,
    managed: true, transport: "company-direct" as const,
    protocol: p.wire_api === "anthropic" ? "anthropic-messages" as const : p.wire_api === "chat" ? "openai-chat-completions" as const : "openai-responses" as const,
    baseUrl: p.options.baseURL, model
  })));
}

export function directProvider(d: CompanyDirectModels, id: string) {
  const prefix = "company-text/";
  if (!id.startsWith(prefix)) throw new Error("文本模型不属于公司直连授权。");
  const value = id.slice(prefix.length), split = value.indexOf("/");
  const providerId = value.slice(0, split), model = value.slice(split + 1);
  const p = Object.hasOwn(d.provider, providerId) ? d.provider[providerId] : undefined;
  if (split < 1 || !p || !Object.hasOwn(p.models, model)) throw new Error("文本模型不在当前直连授权中。");
  return p;
}
