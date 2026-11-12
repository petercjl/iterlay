import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSkillLibrary, AgentSkillLibraryMutation, PiAgentResourceEntry } from "../shared/types.js";
import { MutationQueue, writeJsonAtomic } from "./storage/atomic-json.js";

const queues = new Map<string, MutationQueue>();
const empty = (): AgentSkillLibrary => ({ version: 1, folders: [], assignments: {}, favorites: [] });
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export async function readSkillLibrary(agentDir: string): Promise<AgentSkillLibrary> {
  const file = path.join(agentDir, "skill-library.json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error("Skill 分类配置格式无效。");
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== 1 || !Array.isArray(value.folders) || !Array.isArray(value.favorites)
      || !value.assignments || typeof value.assignments !== "object" || Array.isArray(value.assignments)) throw new Error("Skill 分类配置格式无效。");
    if (value.folders.some((folder: AgentSkillLibrary["folders"][number]) => !folder || typeof folder.id !== "string" || typeof folder.name !== "string"
      || (folder.parentId !== null && typeof folder.parentId !== "string"))
      || value.favorites.some((item: unknown) => typeof item !== "string")
      || Object.values(value.assignments).some((item) => typeof item !== "string")) throw new Error("Skill 分类配置格式无效。");
    const ids = new Set<string>(value.folders.map((folder: { id: string }) => folder.id));
    if (ids.size !== value.folders.length) throw new Error("Skill 文件夹编号重复。");
    for (const folder of value.folders) {
      const seen = new Set<string>([folder.id]); let current = folder;
      while (current.parentId !== null) {
        if (!ids.has(current.parentId) || seen.has(current.parentId)) throw new Error("Skill 文件夹层级无效。");
        seen.add(current.parentId); current = value.folders.find((item: { id: string }) => item.id === current.parentId);
      }
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw error;
  }
}

export async function mutateSkillLibrary(agentDir: string, operation: AgentSkillLibraryMutation, skills: PiAgentResourceEntry[]): Promise<AgentSkillLibrary> {
  const file = path.join(agentDir, "skill-library.json");
  let queue = queues.get(file); if (!queue) { queue = new MutationQueue(); queues.set(file, queue); }
  return queue.run(async () => {
    const library = await readSkillLibrary(agentDir);
    if (!operation || typeof operation !== "object") throw new Error("Skill 分类操作无效。");
    const folderById = (id: string) => {
      const folder = library.folders.find((item) => item.id === id);
      if (!folder) throw new Error("文件夹已不存在，请刷新。");
      return folder;
    };
    const name = (raw: unknown, parentId: string | null, except?: string) => {
      if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 80 || /[\\/\x00-\x1f]/u.test(raw)) throw new Error("文件夹名称需为 1–80 个字符，不能包含斜线。");
      const value = raw.trim();
      if (library.folders.some((item) => item.id !== except && item.parentId === parentId && item.name.toLocaleLowerCase() === value.toLocaleLowerCase())) throw new Error("当前分类下已有同名文件夹。");
      return value;
    };
    switch (operation.type) {
      case "createFolder": {
        if (library.folders.length >= 500) throw new Error("Skill 文件夹数量已达上限。");
        const parentId = operation.parentId ?? null; if (parentId !== null) folderById(parentId);
        library.folders.push({ id: crypto.randomUUID(), name: name(operation.name, parentId), parentId }); break;
      }
      case "renameFolder": {
        const folder = folderById(operation.id); folder.name = name(operation.name, folder.parentId, folder.id); break;
      }
      case "deleteFolder": {
        folderById(operation.id); const deleted = new Set([operation.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const folder of library.folders) if (folder.parentId && deleted.has(folder.parentId) && !deleted.has(folder.id)) { deleted.add(folder.id); changed = true; }
        }
        library.folders = library.folders.filter((folder) => !deleted.has(folder.id));
        for (const [skill, folder] of Object.entries(library.assignments)) if (deleted.has(folder)) delete library.assignments[skill];
        break;
      }
      case "setFolder":
      case "setFavorite": {
        const skill = skills.find((item) => item.path === operation.skillPath);
        if (!skill) throw new Error("Skill 已不存在，请刷新。");
        if (operation.type === "setFolder") {
          if (skill.skillCategory === "system") throw new Error("系统 Skill 保持系统分类。");
          if (operation.folderId !== null) { folderById(operation.folderId); Object.defineProperty(library.assignments, skill.path, { value: operation.folderId, writable: true, configurable: true, enumerable: true }); }
          else if (own(library.assignments, skill.path)) delete library.assignments[skill.path];
        } else {
          if (typeof operation.favorite !== "boolean") throw new Error("收藏状态无效。");
          library.favorites = library.favorites.filter((item) => item !== skill.path);
          if (operation.favorite) library.favorites.push(skill.path);
        }
        break;
      }
      default: throw new Error("不支持的 Skill 分类操作。");
    }
    await writeJsonAtomic(file, library);
    return library;
  });
}
