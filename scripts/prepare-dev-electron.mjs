import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "..");

/** An isolated development bundle supplies the OS name without changing Electron's dependency. */
export async function prepareDevElectron() {
  const executable = require("electron");
  if (process.platform !== "darwin") return executable;
  const sourceApp = path.resolve(executable, "../../..");
  const brand = JSON.parse(await readFile(path.join(projectRoot, "shared/brand.json"), "utf8"));
  const version = require("electron/package.json").version;
  const icon = path.join(projectRoot, "build/icon.icns");
  const pnpm = execFileSync("/usr/bin/which", ["pnpm"], { encoding: "utf8" }).trim();
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh\ncd ${quote(projectRoot)} || exit 1\nexport PATH=${quote(`${path.dirname(process.execPath)}:${path.dirname(pnpm)}`)}:"$PATH"\nexec ${quote(pnpm)} electron:dev\n`;
  const key = createHash("sha256")
    .update("tuda-dev-bundle-v3-single-runtime")
    .update(`${version}-${process.arch}`)
    .update(projectRoot)
    .update(process.execPath)
    .update(JSON.stringify(brand))
    .update(await readFile(icon))
    .update(await readFile(path.join(sourceApp, "Contents/Info.plist")))
    .digest("hex").slice(0, 16);
  const parent = path.join(projectRoot, "tmp/desktop-runtime/current");
  const targetApp = path.join(parent, `${brand.name}.app`);
  const targetExecutable = path.join(targetApp, "Contents/MacOS/Electron");
  const receipt = path.join(parent, "managed-runtime.json");
  try {
    const installed = JSON.parse(await readFile(receipt, "utf8"));
    await access(targetExecutable);
    if (installed.key === key) return targetExecutable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // Replace only an idle runtime. User data lives outside this directory.
  const commands = execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" });
  if (commands.split("\n").some((command) => command.includes(`${targetApp}/Contents/`))) {
    throw new Error("请先退出 Tuda Dev 并完成保存，再更新开发运行包。");
  }
  await mkdir(parent, { recursive: true });
  // Exclude the transient bundle from Spotlight while it is being prepared.
  const stagingRoot = path.join(projectRoot, "tmp/desktop-runtime/.staging.noindex");
  await mkdir(stagingRoot, { recursive: true });
  const lock = path.join(parent, ".prepare-lock");
  await mkdir(lock);
  const staging = await mkdtemp(path.join(stagingRoot, "prepare-"));
  const stagedApp = path.join(staging, `${brand.name}.app`);
  try {
    execFileSync("/bin/cp", ["-cR", sourceApp, stagedApp]);
    const plist = path.join(stagedApp, "Contents/Info.plist");
    for (const [field, value] of Object.entries({
      CFBundleName: brand.name,
      CFBundleDisplayName: brand.name,
      CFBundleIdentifier: `${brand.appId}.dev`,
      CFBundleExecutable: "Tuda",
      CFBundleIconFile: "tuda.icns"
    })) {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${field}`, plist], { stdio: "ignore" });
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${field} string ${value}`, plist]);
    }
    await writeFile(path.join(stagedApp, "Contents/MacOS/Tuda"), launcher, { mode: 0o755, flag: "wx" });
    await copyFile(icon, path.join(stagedApp, "Contents/Resources/tuda.icns"));
    execFileSync("/usr/bin/codesign", ["--deep", "--force", "--sign", "-", "--preserve-metadata=entitlements,requirements,flags,runtime", stagedApp], { stdio: "pipe" });
    if (await access(targetApp).then(() => true, () => false)) {
      execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-u", targetApp]);
    }
    await rm(targetApp, { recursive: true, force: true });
    await rm(receipt, { force: true });
    await rename(stagedApp, targetApp);
    await writeFile(receipt, JSON.stringify({ key, electronVersion: version, appId: `${brand.appId}.dev` }, null, 2), { flag: "wx" });
    return targetExecutable;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(await prepareDevElectron() + "\n");
}
