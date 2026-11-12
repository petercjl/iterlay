import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { c } from "tar";
const pkgPath = path.resolve("cli/package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
const app = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
const arch = process.argv.includes("--arch") ? process.argv[process.argv.indexOf("--arch") + 1] : "x64";
if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported architecture");
const installer = path.resolve(`release/Tuda-${app.version}-${arch}.exe`);
const bytes = await readFile(installer);
if (bytes.length < 1_000_000 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("A real Windows installer is required.");
const payloadRoot = path.resolve("release", `npm-payloads-${randomUUID()}`);
await mkdir(payloadRoot, { recursive: false });
const parts = [];
for (let offset = 0; offset < bytes.length; offset += 48 * 1024 * 1024) {
  const block = bytes.subarray(offset, offset + 48 * 1024 * 1024);
  const sha256 = createHash("sha256").update(block).digest("hex");
  const version = `0.0.0-payload.${sha256}`;
  const directory = path.join(payloadRoot, sha256, "package");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "payload.bin"), block, { flag: "wx" });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: pkg.name, version, description: "Internal Tuda Windows installer data. Use @petercjl/tuda@latest.",
    license: "MIT", repository: pkg.repository, files: ["payload.bin"], publishConfig: { access: "public" }
  }) + "\n", { flag: "wx" });
  const file = path.join(payloadRoot, `tuda-${version}.tgz`);
  await c({ gzip: true, portable: true, noMtime: true, cwd: path.dirname(directory), file }, ["package"]);
  parts.push({ url: `https://registry.npmjs.org/@petercjl/tuda/-/tuda-${version}.tgz`, sha256, fileSize: block.length });
}
const release = { schemaVersion: 1, applicationVersion: app.version, installers: [{
  version: app.version, platform: "win32", arch, channel: app.version.includes("-") ? "beta" : "stable",
  downloadUrl: parts[0].url, npmPayloads: parts,
  sha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.length,
  publishedAt: new Date().toISOString(), releaseNotes: `Tuda · 图塔 ${pkg.version}`
}] };
const backup = path.resolve("tmp", `release-metadata-${randomUUID()}`);
await mkdir(backup, { recursive: true });
for (const [file, value] of [[pkgPath, { ...pkg, tudaRelease: release }], [path.resolve("cli/release-manifest.json"), release]]) {
  await copyFile(file, path.join(backup, path.basename(file)));
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
console.log(JSON.stringify({ ok: true, managerVersion: pkg.version, applicationVersion: app.version, payloadRoot, sha256: release.installers[0].sha256, backup }, null, 2));
