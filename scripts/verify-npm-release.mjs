// Read-only registry verification before promoting the manager's release binding.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
const release = JSON.parse(await readFile(process.argv[2], "utf8"));
for (const installer of release.installers) {
  const whole = createHash("sha256");
  let total = 0;
  for (const part of installer.npmPayloads) {
    if (part.url !== `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${part.sha256}.tgz`) throw Error("Unexpected payload origin");
    let response;
    for (let attempt = 0; attempt < 60; attempt++) {
      response = await fetch(part.url, { signal: AbortSignal.timeout(30_000), headers: { "cache-control": "no-cache" } }).catch(() => undefined);
      if (response?.ok) break;
      const status = response?.status;
      await response?.body?.cancel();
      if (status && status !== 404 && status !== 429 && status < 500) throw Error(`Payload unavailable: ${status}; inspect this exact release before retrying`);
      console.log(`Waiting for npm payload visibility (${attempt + 1}/60)`);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    if (!response?.ok) throw Error("npm payload propagation pending; preserve the exact version and inspect publication before retrying");
    const tar = gunzipSync(Buffer.from(await response.arrayBuffer()), { maxOutputLength: 49 * 1024 * 1024 });
    let payload;
    for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
      const header = tar.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
      const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw Error("Invalid payload archive");
      if (name === "package/payload.bin") {
        if (payload || ![0, 48].includes(header[156])) throw Error("Invalid payload entry");
        payload = tar.subarray(offset + 512, offset + 512 + size);
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (!payload || payload.length !== part.fileSize || createHash("sha256").update(payload).digest("hex") !== part.sha256) throw Error("Registry payload integrity mismatch");
    whole.update(payload); total += payload.length;
  }
  if (total !== installer.fileSize || whole.digest("hex") !== installer.sha256) throw Error("Registry installer integrity mismatch");
  console.log(JSON.stringify({ ok: true, applicationVersion: installer.version, platform: installer.platform, arch: installer.arch, fileSize: total, sha256: installer.sha256, source: "npm" }));
}
