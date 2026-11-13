import { describe, expect, it, vi } from "vitest";
import { NpmUpdateApiClient } from "../electron/updater/npm-api-client.js";
const query = { platform: "win32" as const, arch: "x64" as const, currentVersion: "0.1.0" };
const part = { url: `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${"a".repeat(64)}.tgz`, sha256: "a".repeat(64), fileSize: 100 };
const manifest = { version: "0.2.0", platform: "win32", arch: "x64", downloadUrl: part.url, npmPayloads: [part], sha256: "a".repeat(64), fileSize: 100 };
const registry = (value: unknown) => vi.fn(async (...args: unknown[]) => { void args; return new Response(JSON.stringify(value)); });
describe("npm update discovery", () => {
  it("selects only the installed Windows architecture and requires checksums", async () => {
    const request = registry({ version: "0.2.0", tudaRelease: { schemaVersion: 1, applicationVersion: "0.2.0", installers: [manifest] } });
    const client = new NpmUpdateApiClient(request);
    expect(await client.fetchLatest(query)).toEqual({ ...manifest, channel: "stable" });
    expect(request.mock.calls[0]?.[0]).toBe("https://registry.npmjs.org/%40petercjl%2Ftuda-desktop/latest");
    expect(await client.fetchLatest({ ...query, arch: "arm64" })).toBeNull();
  });
  it("discovers the same desktop release through the mirror when the official registry times out", async () => {
    const request = vi.fn(async (...args: unknown[]) => {
      if (String(args[0]).includes("registry.npmjs.org")) throw new DOMException("timeout", "TimeoutError");
      return new Response(JSON.stringify({ version: "0.2.0", tudaRelease: { schemaVersion: 1, applicationVersion: "0.2.0", installers: [manifest] } }));
    });
    expect(await new NpmUpdateApiClient(request).fetchLatest(query)).toEqual({ ...manifest, channel: "stable" });
    expect(request.mock.calls[1]?.[0]).toBe("https://registry.npmmirror.com/%40petercjl%2Ftuda-desktop/latest");
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
      await expect(new NpmUpdateApiClient(registry({ version: "0.2.0", tudaRelease: { schemaVersion: 1, applicationVersion: "0.2.0", installers: [{ ...manifest, ...patch }] } })).fetchLatest(query)).rejects.toThrow("清单无效");
    }
  });
});
