import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareTudaAgentHome, rebaseAgentPath, tudaAgentHome } from "../electron/tuda-agent-home.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "tuda-agent-home-")); roots.push(home);
  const old = path.join(home, "project", "tmp", "user-data");
  const scope = path.join("tuda-agent", "enterprise", "employee");
  const skill = path.join(scope, "skills", "test", "SKILL.md");
  await mkdir(path.dirname(path.join(old, skill)), { recursive: true });
  await writeFile(path.join(old, skill), "skill-marker");
  await writeFile(path.join(old, scope, "auth.json"), '{"credential":"fixture-private"}');
  await writeFile(path.join(old, scope, "settings.json"), JSON.stringify({ skills: [path.join(old, skill)], extensions: [] }));
  await mkdir(path.join(old, scope, "sessions"));
  await writeFile(path.join(old, scope, "sessions", "session.jsonl"), '{"session":"retained"}\n');
  return { home, old, scope, skill };
}
it("imports Pi config, skills and sessions to a stable private home and keeps the original", async () => {
  const f = await fixture(), root = await prepareTudaAgentHome(f.home, true, f.old);
  expect(root).toBe(path.join(f.home, ".tuda", "dev"));
  expect(await readFile(path.join(root, f.skill), "utf8")).toBe("skill-marker");
  expect(await readFile(path.join(f.old, f.skill), "utf8")).toBe("skill-marker");
  expect(await readFile(path.join(root, f.scope, "sessions", "session.jsonl"), "utf8")).toContain("retained");
  expect(JSON.parse(await readFile(path.join(root, f.scope, "settings.json"), "utf8")).skills).toEqual([path.join(root, f.skill)]);
  if (process.platform !== "win32") {
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, f.scope, "auth.json"))).mode & 0o777).toBe(0o600);
  }
  await writeFile(path.join(f.old, f.skill), "stale-old-update");
  await prepareTudaAgentHome(f.home, true, f.old);
  expect(await readFile(path.join(root, f.skill), "utf8")).toBe("skill-marker");
});
it("preserves existing home data and imports missing files without overwriting", async () => {
  const f = await fixture(), root = tudaAgentHome(f.home, true);
  await mkdir(path.dirname(path.join(root, f.skill)), { recursive: true });
  await writeFile(path.join(root, f.skill), "existing-user-content");
  await prepareTudaAgentHome(f.home, true, f.old);
  expect(await readFile(path.join(root, f.skill), "utf8")).toBe("existing-user-content");
  expect(await readFile(path.join(root, f.scope, "auth.json"), "utf8")).toContain("fixture-private");
  expect(tudaAgentHome(f.home, false)).not.toBe(root);
  expect(rebaseAgentPath("/external/SKILL.md", f.old, root)).toBe("/external/SKILL.md");
});
it("rejects a symlink used as the persistent home", async () => {
  const f = await fixture();
  await symlink(f.old, path.join(f.home, ".tuda"), process.platform === "win32" ? "junction" : "dir");
  await expect(prepareTudaAgentHome(f.home, true, f.old)).rejects.toThrow("本地真实文件夹");
});
