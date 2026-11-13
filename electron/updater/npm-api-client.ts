import type { UpdateApiClient, UpdateCheckQuery, UpdateFetch } from "./api-client.js";
import { isUpdateManifest, type UpdateManifest } from "../../shared/app-update.js";
import { BRAND } from "../../shared/brand.js";
import { validNpmPayloads } from "./npm-payload.js";
import { readNpmRegistry } from "./npm-registry.js";

/** npm supplies version discovery and immutable installer payloads. */
export class NpmUpdateApiClient implements UpdateApiClient {
  constructor(private readonly fetcher: UpdateFetch = fetch, private readonly packageName = BRAND.desktopPackageName) {}
  async fetchLatest(query: UpdateCheckQuery): Promise<UpdateManifest | null> {
    // Customer releases are Windows only. macOS is a desktop development target.
    if (query.platform !== "win32") return null;
    const tag = query.channel === "beta" ? "next" : "latest";
    const pkg = await readNpmRegistry(`https://registry.npmjs.org/${encodeURIComponent(this.packageName)}/${tag}`, this.fetcher, async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`无法读取 Tuda npm 版本（${response.status}）。`);
      try {
        return await response.json() as { version?: string; tudaRelease?: { schemaVersion?: number; applicationVersion?: string; installers?: UpdateManifest[] } };
      } catch {
        throw new Error("Tuda 更新清单无效，已保留当前版本。");
      }
    }, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(40_000), bodyIdleTimeoutMs: 10_000 });
    if (!pkg) return null;
    if (pkg.tudaRelease?.schemaVersion !== 1 || !Array.isArray(pkg.tudaRelease.installers)) return null;
    const manifest = pkg.tudaRelease.installers.find((item) => item.platform === query.platform && item.arch === query.arch);
    if (!manifest) return null;
    if (!isUpdateManifest(manifest) || !/^[a-f0-9]{64}$/i.test(manifest.sha256 ?? "")
      || !Number.isSafeInteger(manifest.fileSize) || (manifest.fileSize ?? 0) <= 0
      || !validNpmPayloads(manifest)
      || manifest.downloadUrl !== manifest.npmPayloads?.[0]?.url
      || manifest.version !== pkg.tudaRelease.applicationVersion
      || (tag === "latest" && (manifest.channel === "beta" || manifest.version.includes("-")))) {
      throw new Error("Tuda 更新清单无效，已保留当前版本。");
    }
    return { ...manifest, channel: tag === "next" ? "beta" : "stable" };
  }
}
