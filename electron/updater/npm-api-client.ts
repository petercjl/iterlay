import type { UpdateApiClient, UpdateCheckQuery, UpdateFetch } from "./api-client.js";
import { compareVersions, isUpdateManifest, type UpdateManifest } from "../../shared/app-update.js";
import { DESKTOP_PATCH_BASELINE, validDesktopPatch } from "../../shared/desktop-patch.js";
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
    const legacy = pkg?.tudaRelease;
    const installer = legacy?.schemaVersion === 1 && Array.isArray(legacy.installers)
      ? legacy.installers.find(item => item?.platform === query.platform && item.arch === query.arch) : undefined;
    if (installer && (!validRelease(installer, legacy?.applicationVersion, query) || installer.patch || installer.fullFallback)) {
      throw new Error("Tuda 更新清单无效，已保留当前版本。");
    }
    const channel = query.channel ?? "stable";
    const full = installer ? { ...installer, channel } : null;
    if (compareVersions(query.currentVersion, DESKTOP_PATCH_BASELINE) < 0) return full;

    try {
      const metadata = await this.read(channel === "beta" ? "desktop-patch-beta" : "desktop-patch");
      const release = metadata?.tudaPatchRelease;
      if (!release) return full;
      if (release.schemaVersion !== 1 || metadata.version !== release.applicationVersion || !Array.isArray(release.patches)) {
        throw new Error("Tuda 差分更新清单无效。");
      }
      const matches = release.patches.filter(item => item?.platform === query.platform && item.arch === query.arch
        && item.patch?.baseVersion === query.currentVersion);
      const [patch] = matches;
      if (!patch) return full;
      if (matches.length !== 1 || !validRelease(patch, release.applicationVersion, query) || !validDesktopPatch(patch) || patch.fullFallback) {
        throw new Error("Tuda 差分更新清单无效。");
      }
      if (full && compareVersions(full.version, patch.version) > 0) return full;
      return { ...patch, channel, fullFallback: full?.version === patch.version ? full : undefined };
    } catch (error) {
      if (full && compareVersions(full.version, query.currentVersion) > 0) return full;
      throw error;
    }
  }

  private read(tag: string) {
    return readNpmRegistry(`https://registry.npmjs.org/${encodeURIComponent(this.packageName)}/${tag}`, this.fetcher, async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`无法读取 Tuda npm 版本（${response.status}）。`);
      try {
        return await response.json() as {
          version?: string;
          tudaRelease?: { schemaVersion?: number; applicationVersion?: string; installers?: UpdateManifest[] };
          tudaPatchRelease?: { schemaVersion?: number; applicationVersion?: string; patches?: UpdateManifest[] };
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
