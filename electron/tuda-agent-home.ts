import { copyFile, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function tudaAgentHome(home: string, development: boolean): string {
  return path.join(home, ".tuda", development ? "dev" : "stable");
}

export function rebaseAgentPath(value: string, legacyUserData: string, root: string): string {
  for (const name of ["tuda-agent", "assistant-skills", "pi-agent"]) {
    const from = path.join(legacyUserData, name);
    if (value === from || value.startsWith(from + path.sep)) return path.join(root, name, path.relative(from, value));
  }
  return value;
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

async function privateDirectory(directory: string): Promise<void> {
  if (await exists(directory)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Tuda Agent 配置目录必须是本地真实文件夹。");
  } else await mkdir(directory, { recursive: true, mode: 0o700 });
}

/** Copy missing files only; a pre-existing destination is authoritative. */
async function copyMissing(source: string, destination: string, fromRoot: string, toRoot: string): Promise<void> {
  const info = await lstat(source);
  if (await exists(destination)) {
    const target = await lstat(destination);
    if (!info.isDirectory() || !target.isDirectory() || target.isSymbolicLink()) return;
  } else if (info.isDirectory()) await privateDirectory(destination);
  else if (info.isSymbolicLink()) {
    const link = await readlink(source);
    const resolved = path.resolve(path.dirname(source), link);
    const rebased = resolved === fromRoot || resolved.startsWith(fromRoot + path.sep)
      ? path.join(toRoot, path.relative(fromRoot, resolved)) : resolved;
    await symlink(path.relative(path.dirname(destination), rebased), destination);
    return;
  } else if (info.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const { chmod } = await import("node:fs/promises");
    await chmod(destination, info.mode & 0o100 ? 0o700 : 0o600);
    return;
  } else return;
  for (const name of await readdir(source)) await copyMissing(path.join(source, name), path.join(destination, name), fromRoot, toRoot);
}

/** One import per source. Retains legacy files and never replaces existing home files. */
export async function prepareTudaAgentHome(home: string, development: boolean, legacyUserData: string, legacyLogs = path.join(legacyUserData, "logs")): Promise<string> {
  const root = tudaAgentHome(home, development);
  await privateDirectory(path.join(home, ".tuda"));
  await privateDirectory(root);
  const oldLog = path.join(legacyLogs, "pi-agent.jsonl"), newLog = path.join(root, "logs", "pi-agent.jsonl");
  if (await exists(oldLog) && !await exists(newLog)) {
    await privateDirectory(path.dirname(newLog));
    await copyFile(oldLog, newLog, constants.COPYFILE_EXCL);
    const { chmod } = await import("node:fs/promises"); await chmod(newLog, 0o600);
  }
  const markers = path.join(root, "migrations"); await privateDirectory(markers);
  const id = createHash("sha256").update(path.resolve(legacyUserData)).digest("hex");
  for (const name of ["tuda-agent", "assistant-skills", "pi-agent"]) {
    const source = path.join(legacyUserData, name), destination = path.join(root, name);
    const marker = path.join(markers, `${id}-${name}.json`);
    if (await exists(marker) || !await exists(source)) continue;
    if (!(await lstat(source)).isDirectory()) throw new Error("旧 Agent 数据目录格式无效。");
    await copyMissing(source, destination, source, destination);
    // Pi settings may contain absolute resource paths. Rebase the copied version only.
    if (name === "tuda-agent") {
      for (const space of await readdir(destination, { withFileTypes: true })) {
        if (!space.isDirectory()) continue;
        const scope = path.join(destination, space.name);
        for (const account of await readdir(scope, { withFileTypes: true })) {
          if (!account.isDirectory()) continue;
          const file = path.join(scope, account.name, "settings.json");
          const oldFile = path.join(source, space.name, account.name, "settings.json");
          if (!await exists(file) || !await exists(oldFile) || (await lstat(file)).isSymbolicLink() || (await lstat(oldFile)).isSymbolicLink()) continue;
          const original = await readFile(oldFile, "utf8");
          if (await readFile(file, "utf8") !== original) continue;
          const parsed = JSON.parse(original);
          for (const field of ["skills", "extensions"]) if (Array.isArray(parsed[field])) {
            parsed[field] = parsed[field].map((entry: unknown) => typeof entry === "string" ? rebaseAgentPath(entry, legacyUserData, root) : entry);
          }
          if (JSON.stringify(parsed) !== JSON.stringify(JSON.parse(original))) {
            const backup = `${file}.pre-migration`;
            if (!await exists(backup)) await copyFile(file, backup, constants.COPYFILE_EXCL);
            await writeFile(file, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
          }
        }
      }
    }
    await writeFile(marker, JSON.stringify({ source, destination, importedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
  }
  return root;
}
