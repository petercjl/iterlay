import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageDimensionsFromHeader } from "../../electron/media/image-metadata.js";
import { detectRemoteImageMime } from "../../electron/remote-image.js";
import { ENTERPRISE_ASSET_PREFIX } from "../../shared/enterprise.js";
import { assetId } from "./boards.js";
import type { ServerConfig } from "./config.js";
import { fail } from "./config.js";
import { Database } from "./database.js";

const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav" };
export class AssetsService {
  constructor(readonly db: Database, readonly config: ServerConfig) {}
  async save(orgId: string, bytes: Buffer, mime: string, name = "素材") {
    const maximum = mime.startsWith("video/") ? 512 * 1024 * 1024 : 25 * 1024 * 1024;
    if (!extensions[mime] || !bytes.length || bytes.length > maximum) fail(400, "INVALID_MEDIA", "素材格式无效或超过大小限制。");
    if (mime.startsWith("image/") && (detectRemoteImageMime(bytes) !== mime || !imageDimensionsFromHeader(bytes))) fail(400, "INVALID_IMAGE", "素材内容与图片格式不匹配。");
    const id = randomUUID(), file = `${id}${extensions[mime]}`;
    const directory = path.join(this.config.dataDir, "assets", orgId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
    await this.db.pool.query("INSERT INTO tuda_assets(org_id,id,name,mime,size,hash,file) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [orgId, id, name.slice(0, 200), mime, bytes.length, createHash("sha256").update(bytes).digest("hex"), file]);
    return { id, path: ENTERPRISE_ASSET_PREFIX + id, mimeType: mime, ...imageDimensionsFromHeader(bytes) };
  }
  async upload(orgId: string, data: string) {
    if (typeof data !== "string" || data.length > 36_000_000) fail(400, "INVALID_MEDIA", "素材过大或格式无效。");
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!match) fail(400, "INVALID_IMAGE", "需要有效的图片内容。");
    return this.save(orgId, Buffer.from(match[2], "base64"), match[1]);
  }
  async locate(orgId: string, value: string) {
    const id = value.startsWith(ENTERPRISE_ASSET_PREFIX) ? assetId(value) : assetId(ENTERPRISE_ASSET_PREFIX + value);
    const result = await this.db.pool.query("SELECT * FROM tuda_assets WHERE org_id=$1 AND id=$2", [orgId, id]);
    if (!result.rowCount) fail(404, "ASSET_NOT_FOUND", "素材不存在或无权访问。");
    const row = result.rows[0];
    return { ...row, absolutePath: path.join(this.config.dataDir, "assets", orgId, row.file) };
  }
  async dataUrl(orgId: string, value: string) {
    const asset = await this.locate(orgId, value);
    if (Number(asset.size) > 32 * 1024 * 1024) fail(400, "ASSET_TOO_LARGE", "素材过大，请通过下载获取。");
    return `data:${asset.mime};base64,${(await readFile(asset.absolutePath)).toString("base64")}`;
  }
}
