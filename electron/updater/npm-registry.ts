import type { UpdateFetch } from "./api-client.js";

const official = "https://registry.npmjs.org";
const mirror = "https://registry.npmmirror.com";

/** Public desktop metadata and immutable payloads only; credentials stay local. */
export function npmRegistryUrls(input: string): string[] {
  const url = new URL(input);
  const pathname = decodeURIComponent(url.pathname);
  if (url.origin !== official || url.username || url.password || url.search || url.hash
    || !/^\/@petercjl\/tuda-desktop\/(?:latest|next|-\/tuda-desktop-0\.0\.0-payload\.[a-f0-9]{64}\.tgz)$/.test(pathname)) {
    throw new Error("Tuda npm 更新地址无效。");
  }
  return [url.href, mirror + url.pathname];
}

interface NpmRequestOptions {
  signal?: AbortSignal; headers?: HeadersInit; connectTimeoutMs?: number; bodyIdleTimeoutMs?: number;
}

/** Retry a complete, validated read so partial files never cross registry attempts. */
export async function readNpmRegistry<T>(input: string, fetcher: UpdateFetch,
  read: (response: Response, signal: AbortSignal, onData: () => void) => Promise<T>,
  options: NpmRequestOptions = {}
): Promise<T> {
  const urls = npmRegistryUrls(input);
  for (const [index, url] of urls.entries()) {
    options.signal?.throwIfAborted();
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => request.abort(new DOMException("Request timed out", "TimeoutError")), ms);
    };
    deadline(options.connectTimeoutMs ?? 8_000);
    const signal = options.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
    const headers = new Headers(options.headers);
    if (index > 0) { headers.delete("authorization"); headers.delete("cookie"); }
    const onData = () => deadline(options.bodyIdleTimeoutMs ?? 30_000);
    try {
      const response = await fetcher(url, { signal, headers, credentials: "omit", cache: "no-store" });
      if (!response.ok && index < urls.length - 1) { await response.body?.cancel(); continue; }
      onData();
      return await read(response, signal, onData);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error && typeof error === "object" && "code" in error && ["ENOSPC", "EACCES", "EPERM", "EROFS"].includes(String(error.code))) throw error;
      if (index === urls.length - 1) {
        if (error instanceof Error && !["TypeError", "TimeoutError", "AbortError"].includes(error.name)) throw error;
        throw new Error("无法连接 npm 官方仓库及备用镜像，请检查网络后重试。");
      }
    } finally {
      clearTimeout(timer!);
    }
  }
  throw new Error("无法连接 npm 更新服务，请稍后重试。");
}

export function fetchNpmRegistry(input: string, fetcher: UpdateFetch, options: NpmRequestOptions = {}): Promise<Response> {
  return readNpmRegistry(input, fetcher, async (response) => response, options);
}
