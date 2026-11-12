import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const project = path.resolve(import.meta.dirname, "..");
const work = await mkdtemp(path.join(os.tmpdir(), "tuda-package-"));
const npmScript = process.platform === "win32" ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : null;
const npm = (args) => execFileSync(npmScript ? process.execPath : "npm", npmScript ? [npmScript, ...args] : args, { cwd: project, encoding: "utf8", env: { ...process.env, TUDA_NO_UPDATE_CHECK: "1" } });
const execute = (entry, args, ok = true) => {
  let out;
  try { out = execFileSync(process.execPath, [entry, ...args, "--json"], { encoding: "utf8", env: { ...process.env, TUDA_NO_UPDATE_CHECK: "1" } }); }
  catch (error) { if (ok) throw error; out = error.stdout; }
  const result = JSON.parse(out);
  assert.equal(result.ok, ok, JSON.stringify(result));
  return result;
};
try {
  const pack = JSON.parse(npm(["pack", "./cli", "--pack-destination", work, "--json", "--ignore-scripts"]));
  const bootstrap = path.join(work, "bootstrap");
  npm(["install", "--prefix", bootstrap, "--ignore-scripts", "--no-audit", "--no-fund", path.join(work, pack[0].filename)]);
  const entry = path.join(bootstrap, "node_modules/@petercjl/tuda/dist/main.js");
  assert.equal(execute(entry, ["version"]).version, "0.1.0");
  execute(entry, ["skill", "install"], false);
  const a = path.join(work, "host-a/using-tuda"), b = path.join(work, "host-b/using-tuda");
  execute(entry, ["skill", "install", "--target", a, "--agent", "arbitrary-agent"]);
  execute(entry, ["skill", "install", "--target", b, "--agent", "generic"]);
  assert.equal(execute(entry, ["skill", "install", "--target", a]).changed, false);
  assert.equal(execute(entry, ["skill", "status", "--target", a]).current, true);
  await rm(path.join(a, ".runtime/dist/main.js"));
  assert.equal(execute(entry, ["skill", "status", "--target", a]).current, false);
  assert.equal(execute(entry, ["skill", "update", "--target", a]).changed, true);
  await writeFile(path.join(a, "SKILL.md"), "user changes", "utf8");
  execute(entry, ["skill", "update", "--target", a], false);
  assert.equal(await readFile(path.join(a, "SKILL.md"), "utf8"), "user changes");
  const unmanaged = path.join(work, "unmanaged/using-tuda");
  await mkdir(unmanaged, { recursive: true });
  await writeFile(path.join(unmanaged, "SKILL.md"), "user owned");
  execute(entry, ["skill", "install", "--target", unmanaged], false);
  await rm(bootstrap, { recursive: true, force: true });
  await rm(path.dirname(a), { recursive: true, force: true });
  const ownEntry = path.join(b, ".runtime/dist/main.js");
  assert.equal(execute(ownEntry, ["version"]).version, "0.1.0");
  assert.equal(execute(ownEntry, ["doctor"]).runtimeReady, true);
  const result = { ok: true, packedInstall: true, explicitTarget: true, arbitraryHost: true, noOp: true, sameVersionRepair: true, localEditsPreserved: true, unmanagedPreserved: true, physicalHostIsolation: true };
  console.log(JSON.stringify(result, null, 2));
} finally { await rm(work, { recursive: true, force: true }); }
