import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("packages only validated deployment defaults and rejects missing or sensitive input before staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-release-defaults-"));
  const source = path.join(root, "defaults.json"), output = path.join(root, "staging");
  const script = fileURLToPath(new URL("../scripts/prepare-company-defaults.mjs", import.meta.url));
  const env = { ...process.env }; delete env.TUDA_COMPANY_DEFAULTS_JSON;
  const run = (input?: string) => spawnSync(process.execPath, [script, "--staging-root", output, ...(input ? ["--source", input] : [])], { encoding: "utf8", env });
  try {
    expect(run().status).not.toBe(0);
    const values = { omniOrigin: "https://omni.example/", accountOrigin: "https://company.example/", nasUrl: "http://nas.example:18473/" };
    await writeFile(source, JSON.stringify(values), { flag: "wx", mode: 0o600 });
    const result = run(source);
    expect(result.status, result.stderr).toBe(0);
    const prepared = JSON.parse(result.stdout);
    expect(JSON.parse(await readFile(prepared.file, "utf8"))).toEqual({ omniOrigin: "https://omni.example", accountOrigin: "https://company.example", nasUrl: "http://nas.example:18473" });
    expect(result.stdout).not.toContain("company.example");
    expect(prepared.sha256).toMatch(/^[a-f0-9]{64}$/);
    const omniSource = path.join(root, "omni-defaults.json");
    const omni = { omniOrigin: "https://omni.example", legacyWorkspaceOrigin: "https://company.example" };
    await writeFile(omniSource, JSON.stringify(omni), { flag: "wx", mode: 0o600 });
    const omniResult = run(omniSource);
    expect(omniResult.status, omniResult.stderr).toBe(0);
    expect(JSON.parse(await readFile(JSON.parse(omniResult.stdout).file, "utf8"))).toEqual(omni);
    for (const [index, patch] of [{ omniOrigin: undefined }, { nasUrl: "" }, { password: "private-fixture" }, { accountOrigin: "http://company.example" }, { nasUrl: "http://user:private-fixture@nas.example" }].entries()) {
      const before = await readdir(output);
      const invalid = path.join(root, `invalid-${index}.json`);
      await writeFile(invalid, JSON.stringify({ ...values, ...patch }), { flag: "wx" });
      expect(run(invalid).status).not.toBe(0);
      expect(await readdir(output)).toEqual(before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
