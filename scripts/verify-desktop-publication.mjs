import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [version, tag, expectedIntegrity] = process.argv.slice(2);
assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert(["latest", "next"].includes(tag));
if (version.includes("-")) assert.equal(tag, "next");
assert.match(expectedIntegrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/);
const name = "@petercjl/tuda-desktop";
async function visible(url, attempts) {
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url + "?verification=" + Date.now(), {signal: AbortSignal.timeout(15_000), headers:{"cache-control":"no-cache"}}).catch(() => null);
    if (r?.ok) return r;
    if (r) {
      const status = r.status; await r.body?.cancel();
      assert(status === 404 || status === 429 || status >= 500, "Unexpected registry response: " + status);
    }
    if (i % 15 === 0) console.log("Waiting for public npm propagation");
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw Error("Public propagation pending; inspect exact publication before retrying");
}
const base = "https://registry.npmjs.org/" + encodeURIComponent(name);
const pkg = await (await visible(base + "/" + version, 180)).json();
assert.equal(pkg.name, name); assert.equal(pkg.version, version);
assert.equal(pkg.dist.integrity, expectedIntegrity);
let tags;
for (let i = 0; i < 180; i++) {
  tags = await (await visible("https://registry.npmjs.org/-/package/" + encodeURIComponent(name) + "/dist-tags", 1)).json();
  if (tags[tag] === version) break;
  await new Promise(resolve => setTimeout(resolve, 4000));
}
assert.equal(tags[tag], version);
assert.equal(pkg.dist.tarball, `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-${version}.tgz`);
const bytes = Buffer.from(await (await visible(pkg.dist.tarball, 90)).arrayBuffer());
assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), expectedIntegrity);
const root = await mkdtemp(path.join(os.tmpdir(), "tuda-desktop-public-"));
let installedExact = false;
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const output = execFileSync("npm", ["install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=20000", "--cache", root + "-cache-" + attempt, name + "@" + version], {encoding:"utf8", stdio:["ignore","pipe","pipe"]});
    console.log(output.trim()); installedExact = true; break;
  } catch (error) {
    const message = String(error.stderr ?? "");
    if (!/ETARGET|E404/.test(message)) throw error;
    console.log("Waiting for npm client metadata propagation");
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
assert(installedExact, "Exact npm install visibility pending; continue read-only verification");
const installed = path.join(root, "node_modules/@petercjl/tuda-desktop");
const actual = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(installed, "release-manifest.json"), "utf8"));
assert.equal(actual.name, name); assert.equal(actual.version, version);
assert.equal(manifest.applicationVersion, version); assert.deepEqual(actual.tudaRelease, manifest);
execFileSync(process.execPath, [path.join(installed, "validate.mjs")], {stdio:"inherit"});
execFileSync(process.execPath, [fileURLToPath(new URL("./verify-npm-release.mjs", import.meta.url)), path.join(installed, "release-manifest.json")], {stdio:"inherit"});
const evidence = {ok:true, package:name, version, tag, integrity:expectedIntegrity, exactRegistryInstall:true, installer:manifest.installers[0], verificationDirectory:root};
await writeFile(path.join(root, "verification.json"), JSON.stringify(evidence,null,2)+"\n", {flag:"wx"});
console.log(JSON.stringify(evidence,null,2));
