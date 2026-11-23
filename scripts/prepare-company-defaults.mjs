import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseCompanyDefaults(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["accountOrigin", "omniOrigin", "legacyWorkspaceOrigin", "nasUrl"].includes(key))) {
    throw new Error("公司部署默认值仅接受 accountOrigin、omniOrigin、legacyWorkspaceOrigin 和 nasUrl。");
  }
  const result = {};
  const keys = ["omniOrigin"];
  if (value.nasUrl !== undefined) keys.push("nasUrl");
  if (value.accountOrigin !== undefined) keys.push("accountOrigin");
  if (value.legacyWorkspaceOrigin !== undefined) keys.push("legacyWorkspaceOrigin");
  for (const key of keys) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`公司部署配置缺少有效的 ${key}。`);
    const url = new URL(value[key].trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (key !== "nasUrl" && (url.pathname !== "/" || (url.protocol !== "https:" && !local)))) {
      throw new Error("公司部署默认连接地址格式无效。");
    }
    result[key] = key === "nasUrl" ? url.href.replace(/\/$/, "") : url.origin;
  }
  return result;
}

/** Only explicitly selected public connection settings enter the installer. */
export async function prepareCompanyDefaults({ sourceFile, sourceJson }, stagingRoot) {
  let text = sourceJson;
  if (sourceFile) {
    const info = await lstat(sourceFile);
    if (!info.isFile() || info.size > 16_384) throw new Error("公司部署默认值需要一个小型 JSON 配置文件。");
    text = await readFile(sourceFile, "utf8");
  }
  if (!text) throw new Error("缺少公司部署默认值，请设置 TUDA_COMPANY_DEFAULTS_JSON 或 --company-defaults 配置文件。");
  const defaults = parseCompanyDefaults(JSON.parse(text));
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(stagingRoot, "company-"));
  const file = path.join(directory, "company-defaults.json");
  const bytes = Buffer.from(JSON.stringify(defaults, null, 2) + "\n");
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), fields: Object.keys(defaults) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--source");
  const out = process.argv.indexOf("--staging-root");
  const result = await prepareCompanyDefaults({ sourceFile: at < 0 ? undefined : process.argv[at + 1], sourceJson: process.env.TUDA_COMPANY_DEFAULTS_JSON },
    out < 0 ? path.resolve("tmp/release-config") : path.resolve(process.argv[out + 1]));
  console.log(JSON.stringify({ ok: true, ...result }));
}
