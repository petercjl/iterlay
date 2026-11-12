import { readFile } from "node:fs/promises";
import path from "node:path";

export interface CompanyDefaults {
  accountOrigin?: string;
  nasUrl?: string;
}
/** Deployment values stay outside the public source and employee workspace. */
export async function loadCompanyDefaults(
  userData: string,
  resourcesPath?: string,
): Promise<CompanyDefaults> {
  let defaults: CompanyDefaults = {};
  for (const directory of [resourcesPath, userData]) {
    if (!directory) continue;
    try {
      const value: unknown = JSON.parse(
        await readFile(path.join(directory, "company-defaults.json"), "utf8"),
      );
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("公司默认配置格式无效。");
      const config = value as Record<string, unknown>;
      for (const key of ["accountOrigin", "nasUrl"] as const) {
        if (config[key] !== undefined && typeof config[key] !== "string")
          throw new Error("公司默认地址格式无效。");
        if (typeof config[key] === "string" && config[key].trim())
          defaults[key] = config[key].trim();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  defaults = {
    ...defaults,
    ...(process.env.TUDA_COMPANY_URL?.trim()
      ? { accountOrigin: process.env.TUDA_COMPANY_URL.trim() }
      : {}),
    ...(process.env.TUDA_NAS_URL?.trim()
      ? { nasUrl: process.env.TUDA_NAS_URL.trim() }
      : {}),
  };
  return defaults;
}
