import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import type { PiAgentResourceEntry } from "../shared/types.js";
import { mutateSkillLibrary, readSkillLibrary } from "../electron/skill-library.js";
import { filterSkillLibrary } from "../src/components/workbench/AgentSkillBoard";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "tuda-skill-library-")); roots.push(root); return root; }
const skills: PiAgentResourceEntry[] = [
  { id: "photo", kind: "skill", name: "产品摄影", description: "电商场景和光线", path: "/skills/photo/SKILL.md", source: "custom", skillCategory: "user" },
  { id: "video", kind: "skill", name: "短视频", description: "分镜脚本", path: "/skills/video/SKILL.md", source: "custom", skillCategory: "user" },
  { id: "base", kind: "skill", name: "系统指南", description: "应用规则", path: "/system/base/SKILL.md", source: "system", skillCategory: "system" }
];
it("persists nested classification and favorites independently of Skill files", async () => {
  const root = await fixture();
  let library = await mutateSkillLibrary(root, { type: "createFolder", name: "电商" }, skills);
  const parent = library.folders[0].id;
  library = await mutateSkillLibrary(root, { type: "createFolder", name: "主图", parentId: parent }, skills);
  const child = library.folders[1].id;
  await mutateSkillLibrary(root, { type: "setFolder", skillPath: skills[0].path, folderId: child }, skills);
  await Promise.all(skills.map((skill) => mutateSkillLibrary(root, { type: "setFavorite", skillPath: skill.path, favorite: true }, skills)));
  library = await readSkillLibrary(root);
  expect(library.assignments[skills[0].path]).toBe(child);
  expect(new Set(library.favorites)).toEqual(new Set(skills.map((skill) => skill.path)));
  expect(filterSkillLibrary(skills, library, "users", "主图")).toEqual([skills[0]]);
  expect(filterSkillLibrary(skills, library, "favorites", "系统")).toEqual([skills[2]]);
  expect(await readSkillLibrary(path.join(root, "another-account"))).toEqual({ version: 1, folders: [], assignments: {}, favorites: [] });
});
it("renames and removes classification without deleting Skills or their favorites", async () => {
  const root = await fixture();
  const untouched = path.join(root, "SKILL.md"); await writeFile(untouched, "keep original content");
  let library = await mutateSkillLibrary(root, { type: "createFolder", name: "摄影" }, skills);
  const parent = library.folders[0].id;
  library = await mutateSkillLibrary(root, { type: "createFolder", name: "商品", parentId: parent }, skills);
  await mutateSkillLibrary(root, { type: "setFolder", skillPath: skills[0].path, folderId: library.folders[1].id }, skills);
  await mutateSkillLibrary(root, { type: "setFavorite", skillPath: skills[0].path, favorite: true }, skills);
  library = await mutateSkillLibrary(root, { type: "renameFolder", id: parent, name: "视觉" }, skills);
  expect(filterSkillLibrary(skills, library, "users", "视觉")).toEqual([skills[0]]);
  library = await mutateSkillLibrary(root, { type: "deleteFolder", id: parent }, skills);
  expect(library.folders).toEqual([]); expect(library.assignments).toEqual({});
  expect(library.favorites).toContain(skills[0].path);
  expect(await readFile(untouched, "utf8")).toBe("keep original content");
});
it("rejects invalid folders, stale paths and categorizing system Skills", async () => {
  const root = await fixture();
  const run = (operation: Parameters<typeof mutateSkillLibrary>[1]) => mutateSkillLibrary(root, operation, skills);
  const library = await run({ type: "createFolder", name: "设计" });
  await expect(run({ type: "createFolder", name: "设计" })).rejects.toThrow("同名");
  await expect(run({ type: "createFolder", name: "../outside" })).rejects.toThrow("斜线");
  await expect(run({ type: "setFavorite", skillPath: "/missing/SKILL.md", favorite: true })).rejects.toThrow("不存在");
  await expect(run({ type: "setFolder", skillPath: skills[2].path, folderId: library.folders[0].id })).rejects.toThrow("系统分类");
  await expect(run({ type: "setFolder", skillPath: skills[0].path, folderId: "missing" })).rejects.toThrow("不存在");
  await run({ type: "setFavorite", skillPath: skills[0].path, favorite: true });
  expect((await run({ type: "setFavorite", skillPath: skills[0].path, favorite: false })).favorites).toEqual([]);
});
it("preserves a corrupt configuration rather than replacing it", async () => {
  const root = await fixture(), file = path.join(root, "skill-library.json");
  await writeFile(file, "user-owned-invalid-config");
  await expect(mutateSkillLibrary(root, { type: "createFolder", name: "新分类" }, skills)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("user-owned-invalid-config");
});
