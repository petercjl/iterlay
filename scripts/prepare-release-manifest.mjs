import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
const pkgPath = path.resolve("cli/package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
const arch = process.argv.includes("--arch") ? process.argv[process.argv.indexOf("--arch") + 1] : "x64";
if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported architecture");
const installer = path.resolve(`release/Tuda-${pkg.version}-${arch}.exe`);
const bytes = await readFile(installer);
if (bytes.length < 1_000_000 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("A real Windows installer is required.");
const release = { schemaVersion: 1, applicationVersion: pkg.version, installers: [{
  version: pkg.version, platform: "win32", arch, channel: pkg.version.includes("-") ? "beta" : "stable",
  downloadUrl: `https://github.com/petercjl/iterlay/releases/download/tuda-v${pkg.version}/${path.basename(installer)}`,
  sha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.length,
  publishedAt: new Date().toISOString(), releaseNotes: `Tuda · 图塔 ${pkg.version}`
}] };
const backup = path.resolve("tmp", `release-metadata-${randomUUID()}`);
await mkdir(backup, { recursive: true });
for (const [file, value] of [[pkgPath, { ...pkg, tudaRelease: release }], [path.resolve("cli/release-manifest.json"), release]]) {
  await copyFile(file, path.join(backup, path.basename(file)));
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
console.log(JSON.stringify({ ok: true, version: pkg.version, sha256: release.installers[0].sha256, backup }, null, 2));
