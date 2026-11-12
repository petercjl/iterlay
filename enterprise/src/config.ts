import { createHash } from "node:crypto";
import path from "node:path";

export interface ServerConfig {
  port: number; host: string; publicUrl: string; databaseUrl: string; dataDir: string; masterKey: Buffer;
  corpId: string; organizationId: string; organizationName: string; clientId: string; clientSecret: string;
  adminIds: string[]; adminUnionId: string; allowHttpLogin: boolean; defaultRole: "editor" | "viewer";
  imageBaseUrl: string; imageApiKey: string; imageModel: string;
  textBaseUrl: string; textApiKey: string; textModel: string;
}
export function readConfig(env = process.env): ServerConfig {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  if (!env.TUDA_MASTER_KEY || env.TUDA_MASTER_KEY.length < 40) throw new Error("TUDA_MASTER_KEY must contain at least 40 random characters.");
  const publicUrl = (env.TUDA_PUBLIC_URL ?? "http://127.0.0.1:18473").replace(/\/$/, "");
  const url = new URL(publicUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("TUDA_PUBLIC_URL must be an HTTP(S) origin.");
  const corpId = env.DINGTALK_CORP_ID ?? "";
  const port = Number(env.PORT ?? 18473);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  return { port, host: env.HOST ?? "0.0.0.0", publicUrl, databaseUrl: env.DATABASE_URL,
    dataDir: path.resolve(env.TUDA_DATA_DIR ?? "./enterprise-data"), masterKey: createHash("sha256").update(env.TUDA_MASTER_KEY).digest(),
    corpId, organizationId: createHash("sha256").update(corpId || "unconfigured").digest("hex").slice(0, 32),
    organizationName: env.TUDA_ORGANIZATION_NAME ?? "企业空间", clientId: env.DINGTALK_CLIENT_ID ?? "", clientSecret: env.DINGTALK_CLIENT_SECRET ?? "",
    adminIds: (env.TUDA_ADMIN_USER_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean),
    adminUnionId: env.DINGTALK_ADMIN_UNION_ID ?? "", allowHttpLogin: env.TUDA_ALLOW_HTTP_LOGIN === "true",
    defaultRole: env.TUDA_DEFAULT_ROLE === "editor" ? "editor" : "viewer",
    imageBaseUrl: env.TUDA_IMAGE_BASE_URL ?? "", imageApiKey: env.TUDA_IMAGE_API_KEY ?? "", imageModel: env.TUDA_IMAGE_MODEL ?? "",
    textBaseUrl: env.TUDA_TEXT_BASE_URL ?? "", textApiKey: env.TUDA_TEXT_API_KEY ?? "", textModel: env.TUDA_TEXT_MODEL ?? "" };
}

export class ServiceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new ServiceError(status, code, message); }
