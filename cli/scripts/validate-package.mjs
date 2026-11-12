import { URL } from "node:url";
import console from "node:console";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const pkg = JSON.parse(await read("package.json"));
const caps = JSON.parse(await read("capabilities.json"));
assert.equal(pkg.name, "@petercjl/tuda");
assert.equal(pkg.version, caps.version);
assert((await read("skills/using-tuda/SKILL.md")).includes(`version: "${pkg.version}"`));
for (const name of ["dist/main.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "INSTALL.md", "UPDATE.md", "release-manifest.json"]) await read(name);
if (pkg.tudaRelease) {
  assert.equal(pkg.tudaRelease.applicationVersion, pkg.version);
  assert(pkg.tudaRelease.installers.length > 0);
  for (const item of pkg.tudaRelease.installers) {
    assert.equal(item.version, pkg.version);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert(item.downloadUrl.startsWith(`https://github.com/petercjl/iterlay/releases/download/tuda-v${pkg.version}/`));
  }
}
console.log(JSON.stringify({ ok: true, package: pkg.name, version: pkg.version, desktopReleasePresent: Boolean(pkg.tudaRelease) }));
