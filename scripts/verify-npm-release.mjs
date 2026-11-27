// Read-only registry verification before promoting the manager's release binding.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
// A large archive may take minutes while still making steady progress.
// Bound connection time, inactivity, total size and total transfer time separately.
async function fetchArchive(url) {
  const controller = new globalThis.AbortController();
  let idle = setTimeout(() => controller.abort(), 15_000);
  const hard = setTimeout(() => controller.abort(), 600_000);
  const progress = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), 30_000); };
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "cache-control": "no-cache" } });
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    if (!response.body) throw Error("Empty archive response");
    progress();
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 49 * 1024 * 1024) throw Error("Archive exceeds payload size limit");
      chunks.push(chunk); progress();
    }
    return { status: response.status, archive: Buffer.concat(chunks) };
  } finally { clearTimeout(idle); clearTimeout(hard); }
}
const release = JSON.parse(await readFile(process.argv[2], "utf8"));
const artifacts = release.installers ?? release.patches;
if (!Array.isArray(artifacts) || artifacts.length === 0) throw Error("No desktop update artifacts to verify");
for (const installer of artifacts) {
  const whole = createHash("sha256");
  let total = 0;
  const payloads = await Promise.all(installer.npmPayloads.map(async (part) => {
    if (part.url !== `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${part.sha256}.tgz`) throw Error("Unexpected payload origin");
    let response;
    for (let attempt = 0; attempt < 240; attempt++) {
      response = await fetchArchive(part.url).catch(() => undefined);
      if (response?.archive) break;
      const status = response?.status;
      if (status && status !== 404 && status !== 429 && status < 500) throw Error(`Payload unavailable: ${status}; inspect this exact release before retrying`);
      console.log(`Waiting for npm payload visibility (${attempt + 1}/240)`);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    if (!response?.archive) throw Error("npm payload propagation pending; preserve the exact version and inspect publication before retrying");
    const tar = gunzipSync(response.archive, { maxOutputLength: 49 * 1024 * 1024 });
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
    console.log(JSON.stringify({ok:true,part:part.sha256,fileSize:payload.length}));
    return payload;
  }));
  for (const payload of payloads) { whole.update(payload); total += payload.length; }
  if (total !== installer.fileSize || whole.digest("hex") !== installer.sha256) throw Error("Registry update artifact integrity mismatch");
  if (installer.patch) {
    const bytes = Buffer.concat(payloads, total);
    let offset = 0;
    for (const file of installer.patch.files) {
      const end = offset + file.fileSize;
      if (!Number.isSafeInteger(file.fileSize) || file.fileSize <= 0 || end > total
        || createHash("sha256").update(bytes.subarray(offset, end)).digest("hex") !== file.sha256) {
        throw Error("Registry differential file integrity mismatch");
      }
      offset = end;
    }
    if (offset !== total) throw Error("Registry differential artifact has unexpected bytes");
  }
  console.log(JSON.stringify({ ok: true, applicationVersion: installer.version, platform: installer.platform, arch: installer.arch, fileSize: total, sha256: installer.sha256, source: "npm" }));
}
