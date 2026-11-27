import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import nodeFs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { UpdateManifest } from "../../shared/app-update.js";
import { validDesktopPatch } from "../../shared/desktop-patch.js";

// Electron treats app.asar as a virtual directory. The updater needs the archive bytes.
const fs = process.versions.electron ? createRequire(import.meta.url)("original-fs") as typeof nodeFs : nodeFs;
const { createReadStream, createWriteStream } = fs;
const { cp, lstat, mkdtemp, realpath, rm, truncate } = fs.promises;

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFile(root: string, name: string) {
  const file = path.join(root, name);
  const info = await lstat(file);
  if (!info.isFile() || await realpath(file) !== file) throw new Error("差分更新的目标文件类型不正确。");
  return file;
}

export async function stageDesktopPatch(
  patchPath: string, applicationPath: string, manifest: UpdateManifest,
): Promise<{ staging: string; candidate: string; applicationRoot: string }> {
  if (!validDesktopPatch(manifest) || !manifest.patch) throw new Error("Tuda 差分清单无效。");
  const isMac = manifest.platform === "darwin";
  const expectedName = isMac ? "Tuda.app" : "Tuda.exe";
  if (path.basename(applicationPath) !== expectedName) throw new Error("差分更新需要正式安装的 Tuda。");
  const applicationRoot = await realpath(isMac ? applicationPath : path.dirname(applicationPath));
  if (!(await lstat(applicationRoot)).isDirectory()) throw new Error("找不到 Tuda 应用目录。");
  if ((await lstat(patchPath)).size !== manifest.fileSize || await hashFile(patchPath) !== manifest.sha256?.toLowerCase()) {
    throw new Error("差分文件校验失败，请重新下载。");
  }
  for (const entry of manifest.patch.files) {
    const file = await regularFile(applicationRoot, entry.path);
    if (await hashFile(file) !== entry.baseSha256) throw new Error("本机应用与此差分的基线不一致，请使用整包更新。");
  }

  const staging = await mkdtemp(path.join(path.dirname(applicationRoot), ".tuda-patch-"));
  const candidate = path.join(staging, isMac ? expectedName : "application");
  try {
    if (isMac) {
      await run("/usr/bin/ditto", [applicationRoot, candidate]);
    } else {
      await cp(applicationRoot, candidate, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    }
    let offset = 0;
    for (const entry of manifest.patch.files) {
      const file = await regularFile(candidate, entry.path);
      for (const range of entry.ranges) {
        await pipeline(
          createReadStream(patchPath, { start: offset, end: offset + range.size - 1 }),
          createWriteStream(file, { flags: "r+", start: range.offset }),
        );
        offset += range.size;
      }
      await truncate(file, entry.fileSize);
      if (await hashFile(file) !== entry.sha256) throw new Error("差分目标文件校验失败。");
    }
    if (isMac) await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate]);
    return { staging, candidate, applicationRoot };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function activateDesktopPatch(
  staged: Awaited<ReturnType<typeof stageDesktopPatch>>,
  platform: UpdateManifest["platform"], parentPid: number,
): Promise<void> {
  const { staging, candidate, applicationRoot } = staged;
  const backup = path.join(staging, "previous");
  if (platform === "darwin") {
    const script = [
      'pid="$1" app="$2" candidate="$3" backup="$4" staging="$5"',
      'while /bin/kill -0 "$pid" 2>/dev/null; do /bin/sleep 0.2; done',
      '/bin/mv "$app" "$backup" || exit 1',
      'if /bin/mv "$candidate" "$app"; then',
      '  if /usr/bin/open "$app"; then /bin/rm -rf "$staging"; exit 0; fi',
      '  /bin/mv "$app" "$candidate" || exit 1',
      'fi',
      '/bin/mv "$backup" "$app" && /usr/bin/open "$app"',
    ].join("\n");
    await detach("/bin/sh", ["-c", script, "tuda-patch", String(parentPid), applicationRoot, candidate, backup, staging], path.dirname(applicationRoot));
    return;
  }
  const encodedPaths = Buffer.from(JSON.stringify({ staging, candidate, applicationRoot, backup, parentPid }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')) | ConvertFrom-Json`,
    "$parent = Get-Process -Id $p.parentPid -ErrorAction SilentlyContinue",
    "if ($parent -and !$parent.WaitForExit(120000)) { exit 1 }",
    "function Move-AppDirectory([string]$from, [string]$to) {",
    "  for ($attempt = 0; ; $attempt++) {",
    "    try { [IO.Directory]::Move($from, $to); return } catch {",
    "      $cause = $_.Exception.GetBaseException()",
    "      if ($attempt -ge 29 -or ($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException])) { throw }",
    "      Start-Sleep -Milliseconds 500",
    "    }",
    "  }",
    "}",
    "$exe = Join-Path $p.applicationRoot 'Tuda.exe'",
    "try { Move-AppDirectory $p.applicationRoot $p.backup } catch {",
    "  Start-Process -FilePath $exe -WorkingDirectory $p.applicationRoot",
    "  exit 1",
    "}",
    "try {",
    "  Move-AppDirectory $p.candidate $p.applicationRoot",
    "  Start-Process -FilePath $exe -WorkingDirectory $p.applicationRoot",
    "} catch {",
    "  if (Test-Path -LiteralPath $p.applicationRoot) { Move-AppDirectory $p.applicationRoot $p.candidate }",
    "  Move-AppDirectory $p.backup $p.applicationRoot",
    "  Start-Process -FilePath $exe -WorkingDirectory $p.applicationRoot",
    "  exit 1",
    "}",
    "Remove-Item -LiteralPath $p.staging -Recurse -Force -ErrorAction SilentlyContinue",
  ].join("\r\n");
  await detach("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    path.dirname(applicationRoot));
}

async function detach(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("差分应用签名或文件布局校验失败。")));
  });
}
