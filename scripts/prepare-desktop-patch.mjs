import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { desktopPatchPaths, validDesktopPatch } from "../dist-electron/shared/desktop-patch.js";
import { validNpmPayloads } from "../dist-electron/electron/updater/npm-payload.js";
import { prepareDesktopPayloads } from "./desktop-release.mjs";

const args = process.argv.slice(2);
const arg = name => {
  const index = args.indexOf(name);
  assert(index !== -1 && args[index + 1], `Missing ${name}`);
  return args[index + 1];
};
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitPackage = JSON.parse(await fs.readFile("desktop-package/package.json", "utf8"));

if (args[0] === "--release") {
  const output = path.resolve(arg("--out"));
  const patches = await Promise.all(args.slice(1, args.indexOf("--out")).map(async file => JSON.parse(await fs.readFile(file, "utf8"))));
  const version = patches[0]?.version;
  assert(patches.length >= 2 && patches.every(patch => patch.version === version && validDesktopPatch(patch)
    && validNpmPayloads(patch) && patch.downloadUrl === patch.npmPayloads[0].url && /^[a-f0-9]{64}$/u.test(patch.sha256)));
  assert.equal(new Set(patches.map(item => [item.platform, item.arch, item.patch.baseVersion].join("/"))).size, patches.length);
  assert(patches.some(item => item.platform === "darwin" && item.arch === "arm64"));
  assert(patches.some(item => item.platform === "win32" && item.arch === "x64"));
  const release = { schemaVersion: 1, applicationVersion: version, patches };
  const { tudaRelease: _legacy, ...pkg } = gitPackage;
  await fs.mkdir(output, { mode: 0o700 });
  const write = (name, value) => fs.writeFile(path.join(output, name), value, { flag: "wx" });
  await write("package.json", JSON.stringify({ ...pkg, version, tudaPatchRelease: release, files: ["patch-manifest.json", "validate.mjs"] }, null, 2) + "\n");
  const manifest = JSON.stringify(release, null, 2) + "\n";
  await write("patch-manifest.json", manifest);
  await write("validate.mjs", `import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const read=name=>readFileSync(new URL(name,import.meta.url));
const manifest=read("patch-manifest.json");
assert.equal(createHash("sha256").update(manifest).digest("hex"),${JSON.stringify(sha256(manifest))});
const pkg=JSON.parse(read("package.json"));
assert.deepEqual(pkg.tudaPatchRelease,JSON.parse(manifest));
assert.equal(pkg.version,pkg.tudaPatchRelease.applicationVersion);
`);
  await fs.copyFile("desktop-package/.npm-release-kit.json", path.join(output, ".npm-release-kit.json"));
  console.log(JSON.stringify({ output, version, targets: patches.map(item => `${item.platform}/${item.arch}`) }));
} else {
  const base = await fs.realpath(arg("--base"));
  const target = await fs.realpath(arg("--target"));
  const platform = arg("--platform"), arch = arg("--arch");
  assert((platform === "win32" && arch === "x64") || (platform === "darwin" && arch === "arm64"), "Unsupported desktop target");
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(createRequire(require.resolve("electron-builder")).resolve("app-builder-lib/package.json"));
  const asar = builderRequire("@electron/asar");
  const bundledVersion = dir => JSON.parse(asar.extractFile(path.join(dir, platform === "darwin" ? "Contents/Resources/app.asar" : "resources/app.asar"), "package.json")).version;
  const baseVersion = bundledVersion(base), version = bundledVersion(target);
  const listFiles = async (root, relative = "", files = new Map()) => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      const file = path.join(root, name);
      if (entry.isDirectory()) await listFiles(root, name, files);
      else if (entry.isSymbolicLink()) files.set(name, { link: await fs.readlink(file) });
      else {
        assert(entry.isFile(), `Unsupported app entry: ${name}`);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        const info = await fs.stat(file);
        files.set(name, { sha256: hash.digest("hex"), fileSize: info.size, mode: info.mode & 0o777 });
      }
    }
    return files;
  };
  const [before, after] = await Promise.all([listFiles(base), listFiles(target)]);
  const files = [];
  const payload = [];
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(name), next = after.get(name);
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    // electron-builder adds the elevation helper only when creating NSIS.
    if (platform === "win32" && name === "resources/elevate.exe" && old?.sha256 && !next) continue;
    assert(old?.sha256 && next?.sha256 && old.mode === next.mode && desktopPatchPaths[platform].includes(name),
      `Application resources changed outside the differential contract: ${name}. Build a full installer.`);
    const source = await fs.readFile(path.join(base, name));
    const content = await fs.readFile(path.join(target, name));
    assert.equal(sha256(source), old.sha256);
    assert.equal(sha256(content), next.sha256);
    const ranges = [];
    const blockSize = 64 * 1024;
    for (let offset = 0; offset < content.length; offset += blockSize) {
      const end = Math.min(offset + blockSize, content.length);
      if (source.subarray(offset, end).equals(content.subarray(offset, end))) continue;
      const last = ranges.at(-1);
      if (last && last.offset + last.size === offset) last.size += end - offset;
      else ranges.push({ offset, size: end - offset });
    }
    files.push({ path: name, baseSha256: old.sha256, sha256: next.sha256, fileSize: next.fileSize, ranges });
    for (const range of ranges) payload.push(content.subarray(range.offset, range.offset + range.size));
  }
  const bytes = Buffer.concat(payload);
  const manifest = { version, platform, arch, channel: version.includes("-") ? "beta" : "stable",
    sha256: sha256(bytes), fileSize: bytes.length, patch: { baseVersion, files } };
  assert(validDesktopPatch(manifest), "Invalid differential release");
  const { payloadRoot, parts } = await prepareDesktopPayloads(bytes, process.cwd(), gitPackage);
  const manifestPath = path.join(payloadRoot, "patch-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, downloadUrl: parts[0].url, npmPayloads: parts }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ manifestPath, payloadRoot, bytes: bytes.length, baseVersion, version }));
}
