import { describe, expect, it, vi } from "vitest";
import { NpmUpdateApiClient } from "../electron/updater/npm-api-client.js";
const query = { platform: "win32" as const, arch: "x64" as const, currentVersion: "0.1.0" };
const manifest = { version: "0.2.0", platform: "win32", arch: "x64", downloadUrl: "https://example.test/Tuda.exe", sha256: "a".repeat(64), fileSize: 100 };
const registry = (value: unknown) => vi.fn(async () => new Response(JSON.stringify(value)));
describe("npm update discovery", () => {
  it("selects only the installed Windows architecture and requires checksums", async () => {
    const client = new NpmUpdateApiClient(registry({ version: "0.2.0", tudaRelease: { schemaVersion: 1, installers: [manifest] } }));
    expect(await client.fetchLatest(query)).toEqual({ ...manifest, channel: "stable" });
    expect(await client.fetchLatest({ ...query, arch: "arm64" })).toBeNull();
  });
  it("does not request an installer for macOS development", async () => {
    const request = registry({});
    expect(await new NpmUpdateApiClient(request).fetchLatest({ ...query, platform: "darwin" })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves the current app when the package has no release yet", async () => {
    expect(await new NpmUpdateApiClient(async () => new Response("", { status: 404 })).fetchLatest(query)).toBeNull();
  });
  it("rejects missing integrity, version drift and insecure downloads", async () => {
    for (const patch of [{ sha256: undefined }, { version: "0.3.0" }, { downloadUrl: "http://example.test/app.exe" }]) {
      await expect(new NpmUpdateApiClient(registry({ version: "0.2.0", tudaRelease: { schemaVersion: 1, installers: [{ ...manifest, ...patch }] } })).fetchLatest(query)).rejects.toThrow("清单无效");
    }
  });
});
