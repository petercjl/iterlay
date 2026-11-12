import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const read = async name => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const p = await read("package.json"), m = await read("release-manifest.json");
assert.equal(p.name, "@petercjl/tuda-desktop");
assert.equal(p.version, m.applicationVersion);
assert.deepEqual(p.tudaRelease, m, "Prepare the verified Windows release before packing");
assert(m.installers.length > 0);
for (const item of m.installers) {
  assert.equal(item.version, p.version);
  assert.equal(item.platform, "win32");
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
  assert(item.npmPayloads.length > 0);
  assert.equal(item.fileSize, item.npmPayloads.reduce((n, part) => n + part.fileSize, 0));
  for (const part of item.npmPayloads) {
    assert.match(part.sha256, /^[a-f0-9]{64}$/);
    assert(part.fileSize > 0 && part.fileSize <= 48 * 1024 * 1024);
    assert.equal(part.url, `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${part.sha256}.tgz`);
  }
}
console.log(JSON.stringify({ok:true, package:p.name, version:p.version}));
