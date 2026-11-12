import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export function defaultUserDataPath(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Tuda");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "Tuda");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Tuda");
}
export function candidateTudaAppRoots(): string[] {
  if (process.platform === "darwin") return ["/Applications/Tuda.app", path.join(os.homedir(), "Applications/Tuda.app")];
  if (process.platform === "win32") return [path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs/Tuda"), "C:\\Program Files\\Tuda"];
  return ["/opt/Tuda", "/usr/lib/tuda"];
}
export async function resolveTudaApp(explicitRoot?: string): Promise<{ root: string; commandPath: string } | null> {
  for (const root of explicitRoot ? [explicitRoot] : candidateTudaAppRoots()) {
    const commandPath = process.platform === "darwin" ? path.join(root, "Contents/MacOS/Tuda") : path.join(root, process.platform === "win32" ? "Tuda.exe" : "Tuda");
    try { await access(commandPath); return { root, commandPath }; } catch { /* Try next location. */ }
  }
  return null;
}
