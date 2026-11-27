import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const inspect = (...args) => JSON.parse(execFileSync(process.execPath, [entry, ...args, "--json"],
  { encoding: "utf8", env: { ...process.env, TUDA_NO_UPDATE_CHECK: "1" } }));

test("the built CLI advertises the same image task protocols as Tuda", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../shared/contracts/tuda-managed-channel-protocols.json", import.meta.url)));
  const command = inspect("providers", "set", "--help").options;
  assert(command["--kind"].enum.includes("image"));
  assert.deepEqual(command["--image-task-protocol"].enum, Object.keys(catalog.imageTaskProtocols));
  assert.equal(inspect("capabilities").commandContracts["providers set"].sideEffects, "local-write");
});

test("the built CLI's Skill source advertises its existing generic adapter", () => {
  const source = inspect("skill", "source");
  const doctor = inspect("doctor");
  assert.equal(doctor.version, source.version);
  assert(doctor.runtimeReady);
  const capabilities = JSON.parse(readFileSync(new URL("../skills/using-tuda/capabilities.json", import.meta.url)));
  assert(capabilities.target_platforms.includes("generic"));
  assert.equal(capabilities.host_resolution.fallback_adapter, "generic");
});
