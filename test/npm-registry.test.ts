import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNpmRegistry, npmRegistryUrls, readNpmRegistry } from "../electron/updater/npm-registry.js";
import type { UpdateFetch } from "../electron/updater/api-client.js";

const official = "https://registry.npmjs.org/%40petercjl%2Ftuda-desktop/latest";
const mirror = "https://registry.npmmirror.com/%40petercjl%2Ftuda-desktop/latest";
afterEach(() => vi.useRealTimers());
describe("desktop npm transport", () => {
  it("uses the official registry without contacting the mirror when healthy", async () => {
    const fetcher = vi.fn<UpdateFetch>(async () => new Response("ok"));
    expect(await (await fetchNpmRegistry(official, fetcher)).text()).toBe("ok");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(official);
  });
  it("falls back on network failures and removes credentials for the mirror", async () => {
    const fetcher = vi.fn<UpdateFetch>().mockRejectedValueOnce(new DOMException("timeout", "TimeoutError")).mockResolvedValueOnce(new Response("mirror"));
    expect(await (await fetchNpmRegistry(official, fetcher, { headers: { authorization: "fixture", cookie: "fixture", Accept: "application/json" } })).text()).toBe("mirror");
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([official, mirror]);
    const headers = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    expect(headers.get("Accept")).toBe("application/json");
    expect(fetcher.mock.calls[1]?.[1]?.credentials).toBe("omit");
  });
  it("tries the mirror on unavailable HTTP responses", async () => {
    const fetcher = vi.fn<UpdateFetch>().mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(new Response("ok"));
    expect(await (await fetchNpmRegistry(official, fetcher)).text()).toBe("ok");
    expect(fetcher.mock.calls[1]?.[0]).toBe(mirror);
  });
  it("enforces connection deadlines without aborting a healthy large response", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<UpdateFetch>().mockImplementationOnce((_url, init) => new Promise((resolve, reject) => {
      void resolve; void _url;
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })).mockResolvedValueOnce(new Response("ok"));
    const caller = new AbortController();
    const pending = fetchNpmRegistry(official, fetcher, { signal: caller.signal, connectTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    const response = await pending;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(await response.text()).toBe("ok");
    caller.abort(); expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
  });
  it("restarts a stalled response from the mirror before accepting its data", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<UpdateFetch>().mockResolvedValue(new Response("ok"));
    let attempt = 0;
    const pending = readNpmRegistry(official, fetcher, async (_response, signal, onData) => {
      if (++attempt === 2) return "verified mirror data";
      void _response; onData();
      return new Promise<string>((resolve, reject) => { void resolve; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    }, { bodyIdleTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBe("verified mirror data");
    expect(fetcher.mock.calls.map(call=>call[0])).toEqual([official,mirror]);
  });
  it("honors cancellation without starting a fallback request", async () => {
    const caller = new AbortController();
    const fetcher = vi.fn<UpdateFetch>().mockImplementation(async () => { caller.abort(); throw caller.signal.reason; });
    await expect(fetchNpmRegistry(official, fetcher, { signal: caller.signal })).rejects.toHaveProperty("name", "AbortError");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reports an actionable error after both registries fail", async () => {
    const fetcher = vi.fn<UpdateFetch>().mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchNpmRegistry(official, fetcher)).rejects.toThrow("无法连接 npm 官方仓库及备用镜像");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("only maps this application's public metadata and immutable data blocks", () => {
    const payload = `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${"a".repeat(64)}.tgz`;
    expect(npmRegistryUrls(payload)[1]).toBe(payload.replace("registry.npmjs.org", "registry.npmmirror.com"));
    for (const url of ["http://registry.npmjs.org/@petercjl/tuda-desktop/latest", "https://example.com/@petercjl/tuda-desktop/latest", official+"?token=fixture", official+"/../../other/latest", "https://user:secret@registry.npmjs.org/@petercjl/tuda-desktop/latest"]) expect(() => npmRegistryUrls(url)).toThrow();
  });
});
