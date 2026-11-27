import type { UpdateApiClient, UpdateCheckQuery, UpdateFetch } from "./api-client.js";
import { isUpdateManifest, type UpdateManifest } from "../../shared/app-update.js";
import { BRAND } from "../../shared/brand.js";
import { validNpmPayloads } from "./npm-payload.js";
import { readNpmRegistry } from "./npm-registry.js";

/** npm supplies version discovery and immutable installer payloads. */
export class NpmUpdateApiClient implements UpdateApiClient {
  constructor(private readonly fetcher: UpdateFetch = fetch, private readonly packageName = BRAND.desktopPackageName) {}
  async fetchLatest(query: UpdateCheckQuery): Promise<UpdateManifest | null> {
    if (query.platform !== "win32" && query.platform !== "darwin") return null;
    const tag = query.channel === "beta" ? "next" : "latest";
    const pkg = await this.read(tag);
    const release = pkg?.tudaRelease;
    const installer = release?.schemaVersion === 1 && Array.isArray(release.installers)
      ? release.installers.find(item => item?.platform === query.platform && item.arch === query.arch) : undefined;
    if (installer && (!validRelease(installer, release?.applicationVersion, query) || installer.patch || installer.fullFallback)) {
      throw new Error("Tuda 更新清单无效，已保留当前版本。");
    }
    return installer ? { ...installer, channel: query.channel ?? "stable" } : null;
  }

  private read(tag: string) {
    return readNpmRegistry(`https://registry.npmjs.org/${encodeURIComponent(this.packageName)}/${tag}`, this.fetcher, async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`无法读取 Tuda npm 版本（${response.status}）。`);
      try {
        return await response.json() as {
          tudaRelease?: { schemaVersion?: number; applicationVersion?: string; installers?: UpdateManifest[] };
        };
      } catch {
        throw new Error("Tuda 更新清单无效，已保留当前版本。");
      }
    }, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(40_000), bodyIdleTimeoutMs: 10_000 });
  }
}

function validRelease(manifest: UpdateManifest, version: string | undefined, query: UpdateCheckQuery): boolean {
  return isUpdateManifest(manifest) && /^[a-f0-9]{64}$/iu.test(manifest.sha256 ?? "")
    && Number.isSafeInteger(manifest.fileSize) && (manifest.fileSize ?? 0) > 0
    && validNpmPayloads(manifest) && manifest.downloadUrl === manifest.npmPayloads?.[0]?.url
    && manifest.version === version
    && (query.channel === "beta" || (manifest.channel !== "beta" && !manifest.version.includes("-")));
}
