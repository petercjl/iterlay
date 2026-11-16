import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { ensureAgentToapis } from "../electron/company/agent-toapis";
it("automatically installs the pinned canonical Skill and isolated runtime without requiring an employee key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-agent-toapis-"));
  try { const file = await ensureAgentToapis(directory); expect(file).toContain(path.join("system-skills", "toapiscli"));
    expect(await readFile(file, "utf8")).toContain("name: toapiscli");
    expect((await readFile(path.join(path.dirname(file), ".runtime", "dist", "cli.mjs"))).length).toBeGreaterThan(1000);
    expect(await ensureAgentToapis(directory)).toBe(file);
    const {loadSkills} = await import("../electron/agents/coding-runtime");
    expect(loadSkills({cwd: directory, agentDir: directory, skillPaths: [file], includeDefaults: false}).skills.map(s => s.name)).toContain("toapiscli");
  } finally {await rm(directory, {recursive: true, force: true});}
}, 30000);
