import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
const app = process.env.TUDA_PLUGIN_TEST_APP;
assert(app && path.isAbsolute(app), "Set TUDA_PLUGIN_TEST_APP to a packaged development .app");
const userData = await mkdtemp(path.join(os.tmpdir(), "tuda-cold-prepare-"));
const env = { ...process.env, TUDA_EMBEDDED_HOST: "codex-own", TUDA_USER_DATA_PATH: userData, TUDA_COMPANY_URL: "https://company.example.test", TUDA_PLUGIN_SPACE: "enterprise" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TUDA_NO_LAUNCH;
delete env.TUDA_AUTH_HANDOFF_FILE;
await writeFile(path.join(userData, "company-session.json"), JSON.stringify({ version: 1, encrypted: "previous-host-session-must-not-be-restored" }), { flag: "wx", mode: 0o600 });
const started = Date.now();
const prepared = await promisify(execFile)(process.execPath, [path.resolve("cli/dist/main.js"), "desktop", "prepare", "--app-path", app, "--user-data-path", userData, "--startup-timeout", "120", "--json"], { env, timeout: 150000 });
const result = JSON.parse(prepared.stdout);
assert(result.ok && result.data.ready);
assert.match(result.data.instanceId, /^[a-f0-9]{64}$/);
const elapsedMs = Date.now() - started;
const info = JSON.parse(await readFile(path.join(userData, "local-api.json"), "utf8"));
try {
  const logs = await readFile(path.join(userData, "logs/runtime.log"), "utf8");
  assert(logs.includes("company-account-ready"));
  const previous = JSON.parse(await readFile(path.join(userData, "company-session.json"), "utf8"));
  assert.equal(previous.encrypted, "previous-host-session-must-not-be-restored");
  console.log(JSON.stringify({ ok: true, coldPrepareMs: elapsedMs, requiresLogin: false, instanceIdPresent: true, priorSessionPreservedAndUnused: true, userData }));
} finally {
  const response = await fetch(`http://127.0.0.1:${info.port}/board-plugin/host/quit`, { method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) });
  assert(response.ok, "cold background must quit cleanly");
}
