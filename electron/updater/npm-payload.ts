import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x } from "tar";
import type { UpdateManifest } from "../../shared/app-update.js";
import type { UpdateFetch } from "./api-client.js";

export function validNpmPayloads(manifest: UpdateManifest): boolean {
  const parts = manifest.npmPayloads;
  return Array.isArray(parts) && parts.length > 0 && parts.length <= 128 && parts.every((part) =>
    /^[a-f0-9]{64}$/.test(part.sha256) && Number.isSafeInteger(part.fileSize) && part.fileSize > 0 && part.fileSize <= 48 * 1024 * 1024 &&
    part.url === `https://registry.npmjs.org/@petercjl/tuda/-/tuda-0.0.0-payload.${part.sha256}.tgz`
  ) && parts.reduce((sum, part) => sum + part.fileSize, 0) === manifest.fileSize;
}

/** Extract exactly one regular data file; no archive paths are used as executable code. */
export async function* downloadNpmPayloads(manifest: UpdateManifest, fetcher: UpdateFetch, signal?: AbortSignal): AsyncGenerator<Buffer> {
  if (!validNpmPayloads(manifest)) throw new Error("Tuda npm 更新文件清单无效。");
  for (const part of manifest.npmPayloads!) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-payload-"));
    try {
      const response = await fetcher(part.url, { signal });
      if (!response.ok || !response.body) throw new Error(`npm 更新文件下载失败 (${response.status})`);
      let entries = 0, invalid = false, compressedBytes = 0;
      const archive = path.join(directory, "archive.tgz");
      await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk, _encoding, done) {
        compressedBytes += chunk.length;
        done(compressedBytes > 49 * 1024 * 1024 ? new Error("npm 更新文件超出大小限制。") : null, chunk);
      } }), createWriteStream(archive, { flags: "wx" }), { signal });
      await x({ file: archive, cwd: directory, strict: true, preservePaths: false,
        filter: (name, entry) => {
          if (name !== "package/payload.bin") return false;
          if (!("type" in entry) || entry.type !== "File" || entry.size !== part.fileSize || ++entries !== 1) { invalid = true; return false; }
          return true;
        }
      });
      signal?.throwIfAborted();
      if (entries !== 1 || invalid) throw new Error("npm 更新文件格式无效。");
      const bytes = await readFile(path.join(directory, "package", "payload.bin"));
      if (bytes.length !== part.fileSize || createHash("sha256").update(bytes).digest("hex") !== part.sha256) throw new Error("npm 更新文件校验失败。");
      yield bytes;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
