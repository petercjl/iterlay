import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Only Tuda-owned local skill folders may be removed. Shared/package skills are read-only. */
export async function localSkillFolder(agentDir: string, skillPath: string): Promise<string | null> {
  const root = path.resolve(agentDir, "skills");
  const file = path.resolve(skillPath);
  const folder = path.dirname(file);
  if (path.basename(file) !== "SKILL.md" || path.dirname(folder) !== root) return null;
  try {
    const [rootStat, folderStat, fileStat] = await Promise.all([lstat(root), lstat(folder), lstat(file)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !folderStat.isDirectory()
      || folderStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) return null;
    if (path.dirname(await realpath(folder)) !== await realpath(root)) return null;
    return folder;
  } catch { return null; }
}

export async function removeLocalSkill(agentDir: string, skillPath: string, operations: {
  confirm: (folder: string) => Promise<boolean>;
  trash: (folder: string) => Promise<void>;
}): Promise<boolean> {
  const folder = await localSkillFolder(agentDir, skillPath);
  if (!folder) throw new Error("该 Skill 来自共享目录或安装包，请在其来源中管理。仅可删除 Tuda 本地 Skill。");
  if (!await operations.confirm(folder)) return false;
  if (await localSkillFolder(agentDir, skillPath) !== folder) throw new Error("Skill 路径已变化，请刷新后重试。");
  await operations.trash(folder);
  return true;
}

export function selectedSkillCommand(skills: Array<{ filePath: string; name: string }>, skillPath: string | undefined, instruction: string): string {
  if (!skillPath) return instruction;
  const skill = skills.find((item) => path.resolve(item.filePath) === path.resolve(skillPath));
  if (!skill || skills.find((item) => item.name === skill.name) !== skill) {
    throw new Error("所选 Skill 未能加载或名称冲突，请刷新 Skill 看板后重试。");
  }
  return `/skill:${skill.name} ${instruction}`;
}
