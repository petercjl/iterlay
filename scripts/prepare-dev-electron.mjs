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
  const key = createHash("sha256")
    .update("tuda-dev-bundle-v2")
    .update(JSON.stringify(brand))
    .update(await readFile(icon))
    .update(await readFile(path.join(sourceApp, "Contents/Info.plist")))
    .digest("hex").slice(0, 16);
  const parent = path.join(projectRoot, "tmp/desktop-runtime", `${version}-${process.arch}-${key}`);
  const targetApp = path.join(parent, `${brand.name}.app`);
  const targetExecutable = path.join(targetApp, "Contents/MacOS/Electron");
  const receipt = path.join(parent, "managed-runtime.json");
  try {
    const installed = JSON.parse(await readFile(receipt, "utf8"));
    await access(targetExecutable);
    if (installed.key !== key) throw new Error("Unexpected development runtime identity.");
    return targetExecutable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".prepare-"));
  const stagedApp = path.join(staging, `${brand.name}.app`);
  try {
    execFileSync("/bin/cp", ["-cR", sourceApp, stagedApp]);
    const plist = path.join(stagedApp, "Contents/Info.plist");
    for (const [field, value] of Object.entries({
      CFBundleName: brand.name,
      CFBundleDisplayName: brand.name,
      CFBundleIdentifier: `${brand.appId}.dev`,
      CFBundleExecutable: "Electron",
      CFBundleIconFile: "tuda.icns"
    })) {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${field}`, plist], { stdio: "ignore" });
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${field} string ${value}`, plist]);
    }
    await copyFile(icon, path.join(stagedApp, "Contents/Resources/tuda.icns"));
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,requirements,flags,runtime", stagedApp], { stdio: "pipe" });
    // Each content-addressed destination is new; an existing bundle is never replaced.
    await rename(stagedApp, targetApp);
    await writeFile(receipt, JSON.stringify({ key, electronVersion: version, appId: `${brand.appId}.dev` }, null, 2), { flag: "wx" });
    return targetExecutable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(await prepareDevElectron() + "\n");
}
