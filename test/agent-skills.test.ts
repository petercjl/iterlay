import { validateSceneCollaborationRequest } from "../electron/application/assistant-request.js";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { localSkillFolder, removeLocalSkill, selectedSkillCommand } from "../electron/agent-skills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-skill-manager-")); roots.push(root);
  const folder = path.join(root, "skills", "test-skill"); await mkdir(folder, { recursive: true });
  const file = path.join(folder, "SKILL.md"); await writeFile(file, "---\nname: test-skill\ndescription: Test\n---\nTest instructions");
  return { root, folder, file };
}
it("requires confirmation before moving a Tuda local Skill folder to Trash", async () => {
  const f = await fixture(), trash = vi.fn(async () => {});
  expect(await removeLocalSkill(f.root, f.file, { confirm: async () => false, trash })).toBe(false);
  expect(trash).not.toHaveBeenCalled();
  expect(await removeLocalSkill(f.root, f.file, { confirm: async () => true, trash })).toBe(true);
  expect(trash).toHaveBeenCalledWith(f.folder);
});
it("rejects shared paths, root deletion and symlink escapes", async () => {
  const f = await fixture();
  expect(await localSkillFolder(f.root, path.join(f.root, "SKILL.md"))).toBeNull();
  expect(await localSkillFolder(f.root, path.join(f.root, "skills", "SKILL.md"))).toBeNull();
  const external = path.join(f.root, "external"); await mkdir(external); await writeFile(path.join(external, "SKILL.md"), "external");
  await symlink(external, path.join(f.root, "skills", "linked"));
  expect(await localSkillFolder(f.root, path.join(f.root, "skills", "linked", "SKILL.md"))).toBeNull();
  await expect(removeLocalSkill(f.root, path.join(external, "SKILL.md"), { confirm: vi.fn(), trash: vi.fn() })).rejects.toThrow("仅可删除 Tuda 本地");
});
it("routes an explicit Skill through Pi's command expansion and rejects stale or conflicting selections", () => {
  const skills = [{ name: "one", filePath: "/skills/one/SKILL.md" }];
  expect(selectedSkillCommand(skills, skills[0].filePath, "分析图片")).toBe("/skill:one 分析图片");
  expect(selectedSkillCommand(skills, undefined, "分析图片")).toBe("分析图片");
  expect(() => selectedSkillCommand(skills, "/missing/SKILL.md", "分析图片")).toThrow("未能加载");
  expect(() => selectedSkillCommand([...skills, { name: "one", filePath: "/other/SKILL.md" }], "/other/SKILL.md", "分析图片")).toThrow("名称冲突");
});

it("preserves explicit Skill selection through request validation", () => {
  const request = { instruction: "分析图片", workflowMode: "generate", referenceImages: [], currentFields: [], selectedSkillPath: "/skills/test/SKILL.md" };
  expect(validateSceneCollaborationRequest(request).selectedSkillPath).toBe(request.selectedSkillPath);
  expect(() => validateSceneCollaborationRequest({ ...request, selectedSkillPath: { path: "invalid" } })).toThrow("Skill 路径无效");
  expect(() => validateSceneCollaborationRequest({ ...request, selectedSkillPath: " " })).toThrow("Skill 路径无效");
});
