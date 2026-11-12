import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MARKER = "# Tuda CLI (managed by Tuda)";
export interface CliInstallationStatus {
  installed: boolean;
  path: string;
  pathConfigured: boolean;
  error?: string;
}
export interface CliInstallationOptions {
  homeDir: string;
  executable: string;
  scriptPath: string;
  platform?: NodeJS.Platform;
  userDataPath?: string;
  selfTest?: boolean;
}
const quote = (value: string): string => "'" + value.replace(/'/gu, "'\\''") + "'";
export function cliInstallPath(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(homeDir, ".local", "bin", platform === "win32" ? "tuda.cmd" : "tuda");
}
async function isNpmCli(target: string): Promise<boolean> {
  try {
    const entry = await realpath(target);
    if (path.basename(entry) !== "main.js" || path.basename(path.dirname(entry)) !== "dist") return false;
    const pkg = JSON.parse(await readFile(path.join(path.dirname(entry), "..", "package.json"), "utf8"));
    return pkg.name === "@petercjl/tuda" && pkg.bin?.tuda === "dist/main.js";
  } catch { return false; }
}
export async function getCliInstallationStatus(homeDir: string): Promise<CliInstallationStatus> {
  const target = cliInstallPath(homeDir);
  const content = await readFile(target, "utf8").catch(() => "");
  const profile = (await Promise.all([".zshrc", ".bashrc"].map((name) => readFile(path.join(homeDir, name), "utf8").catch(() => "")))).join("\n");
  return { installed: content.includes("Tuda CLI (managed by Tuda)") || await isNpmCli(target), path: target, pathConfigured: (process.env.PATH ?? "").split(path.delimiter).includes(path.dirname(target)) || profile.includes("# >>> Tuda CLI >>>") };
}
export async function installCli(options: CliInstallationOptions): Promise<CliInstallationStatus> {
  const platform = options.platform ?? process.platform;
  const target = cliInstallPath(options.homeDir, platform);
  try {
    if (options.executable.includes("/AppTranslocation/") || options.executable.startsWith("/Volumes/")) throw new Error("请先把 Tuda 移到 Applications，再重新打开以安装命令行工具。");
    await access(options.scriptPath);
    const existing = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
    if (await isNpmCli(target)) return getCliInstallationStatus(options.homeDir);
    if (existing && !existing.includes("Tuda CLI (managed by Tuda)")) throw new Error("同名命令已存在，未覆盖。请检查安装路径。");
    const launcher = platform === "win32"
      ? `@echo off\r\nREM Tuda CLI (managed by Tuda)\r\nset ELECTRON_RUN_AS_NODE=1\r\n${options.userDataPath ? `set TUDA_USER_DATA_PATH=${options.userDataPath}\r\n` : ""}"${options.executable}" "${options.scriptPath}" %*\r\n`
      : `#!/bin/sh\n${MARKER}\nexec env ELECTRON_RUN_AS_NODE=1 ${options.userDataPath ? `TUDA_USER_DATA_PATH=${quote(options.userDataPath)} ` : ""}${quote(options.executable)} ${quote(options.scriptPath)} "$@"\n`;
    await mkdir(path.dirname(target), { recursive: true });
    if (existing && existing !== launcher) await writeFile(target + `.backup-${randomUUID()}`, existing, { flag: "wx", mode: 0o700 });
    const temporary = target + `.update-${randomUUID()}`;
    await writeFile(temporary, launcher, { mode: 0o755, flag: "wx" });
    await chmod(temporary, 0o755);
    await rename(temporary, target);
    if (platform !== "win32") {
      const block = '\n# >>> Tuda CLI >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< Tuda CLI <<<\n';
      for (const profileName of (process.env.SHELL?.endsWith("/bash") ? [".bash_profile", ".bashrc"] : [".zprofile", ".zshrc"])) {
        const profilePath = path.join(options.homeDir, profileName);
        const current = await readFile(profilePath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
        if (!current.includes("# >>> Tuda CLI >>>")) {
          if (current) await writeFile(profilePath + `.tuda-backup-${randomUUID()}`, current, { flag: "wx", mode: 0o600 });
          await writeFile(profilePath, current + block, "utf8");
        }
      }
    }
    if (platform === "win32") {
      const command = "$old=[Environment]::GetEnvironmentVariable('Path','User');$bin=$env:TUDA_CLI_BIN;if (($old -split ';') -notcontains $bin) {[Environment]::SetEnvironmentVariable('Path',($old.TrimEnd(';')+';'+$bin),'User')}";
      await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 10000, env: { ...process.env, TUDA_CLI_BIN: path.dirname(target) } });
    }
    if (options.selfTest) await promisify(execFile)(options.executable, [options.scriptPath, "--version"], { timeout: 10000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    return { installed: true, path: target, pathConfigured: true };
  } catch (error) {
    return { ...await getCliInstallationStatus(options.homeDir), error: error instanceof Error ? error.message : String(error) };
  }
}
