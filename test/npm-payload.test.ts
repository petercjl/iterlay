import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c } from "tar";
import { expect, it } from "vitest";
import { DirectDownloadDriver } from "../electron/updater/driver.js";
import type { UpdateManifest } from "../shared/app-update.js";

it("reassembles npm archives in order, checks blocks and whole installer, and reuses verified downloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-npm-test-"));
  try {
    const blocks = [Buffer.from("MZ-first-block"), Buffer.from("second-block")];
    const archives = new Map<string, Buffer>();
    const parts: NonNullable<UpdateManifest["npmPayloads"]> = [];
    for (const [index, bytes] of blocks.entries()) {
      const folder = path.join(root, String(index));
      await mkdir(path.join(folder, "package"), { recursive: true });
      await writeFile(path.join(folder, "package/payload.bin"), bytes, { flag: "wx" });
      await c({ file: path.join(folder, "part.tgz"), gzip: true, cwd: folder }, ["package"]);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const url = `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${sha256}.tgz`;
      archives.set(url, await readFile(path.join(folder, "part.tgz")));
      parts.push({ url, sha256, fileSize: bytes.length });
    }
    const installer = Buffer.concat(blocks);
    const manifest: UpdateManifest = { version: "1.0.0", platform: "win32", downloadUrl: parts[0].url,
      npmPayloads: parts, sha256: createHash("sha256").update(installer).digest("hex"), fileSize: installer.length };
    let requests = 0;
    const driver = new DirectDownloadDriver({ platform: "win32", downloadDir: path.join(root, "downloads"),
      fetcher: async (url) => { requests++; return new Response(new Uint8Array(archives.get(String(url))!)); } });
    const file = await driver.download(manifest);
    expect(await readFile(file)).toEqual(installer);
    await driver.download(manifest);
    expect(requests).toBe(2);
    await expect(driver.download({ ...manifest, version: "1.0.1", sha256: "f".repeat(64) })).rejects.toThrow("校验失败");
    await expect(driver.download({ ...manifest, version: "1.0.2", npmPayloads: [{ ...parts[0], url: "https://example.com/a.tgz" }] })).rejects.toThrow("清单无效");
    let officialFailures = 0, mirrorDownloads = 0;
    const mirrored = new DirectDownloadDriver({ platform: "win32", downloadDir: path.join(root, "mirrored"),
      fetcher: async (url) => {
        if (String(url).startsWith("https://registry.npmjs.org/")) { officialFailures++; throw new DOMException("timeout", "TimeoutError"); }
        mirrorDownloads++;
        return new Response(new Uint8Array(archives.get(String(url).replace("registry.npmmirror.com", "registry.npmjs.org"))!));
      } });
    expect(await readFile(await mirrored.download(manifest))).toEqual(installer);
    expect(officialFailures).toBe(2); expect(mirrorDownloads).toBe(2);
    const corruptedMirror = new DirectDownloadDriver({ platform: "win32", downloadDir: path.join(root, "bad-mirror"),
      fetcher: async (url) => {
        if (String(url).startsWith("https://registry.npmjs.org/")) throw new TypeError("fetch failed");
        return new Response(new Uint8Array(archives.get(parts[0].url)!));
      } });
    const corruptParts = [{ ...parts[0], sha256: "e".repeat(64), url: parts[0].url.replace(parts[0].sha256, "e".repeat(64)) }, parts[1]];
    await expect(corruptedMirror.download({ ...manifest, npmPayloads: corruptParts })).rejects.toThrow("校验失败");
    const corrupted = new DirectDownloadDriver({ platform: "win32", downloadDir: path.join(root, "bad"),
      fetcher: async () => new Response(new Uint8Array(archives.get(parts[1].url)!)) });
    await expect(corrupted.download(manifest)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
