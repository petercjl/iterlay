import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { installSkill } from "../cli/src/management.js";

it("recovers a managed same-version Skill when a Windows host locks directory rename", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-locked-"));
  const target = path.join(directory, "using-tuda");
  try {
    await installSkill(target);
    await rm(path.join(target, ".runtime/dist/main.js"));
    let lockObserved = false;
    const result = await installSkill(target, { rename: async (from) => {
      expect(from).toBe(target);
      lockObserved = true;
      throw Object.assign(new Error("locked directory"), { code: "EBUSY" });
    } });
    expect(lockObserved).toBe(true);
    expect(result.current).toBe(true);
    expect(result.backup).toBeTruthy();
    expect(await readFile(path.join(target, ".runtime/dist/main.js"), "utf8")).toContain("Tuda");
    await mkdir(path.join(target, "empty-extra-directory"));
    expect((await installSkill(target)).changed).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
