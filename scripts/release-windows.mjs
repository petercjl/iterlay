import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prepareCompanyDefaults } from "./prepare-company-defaults.mjs";
if (process.platform !== "win32") throw new Error("Build customer Windows installers on Windows; macOS uses electron:dev.");
const at = process.argv.indexOf("--arch");
const arch = at >= 0 ? process.argv[at + 1] : "x64";
if (!["x64", "arm64"].includes(arch)) throw new Error("Select --arch x64 or arm64.");
const defaultsAt = process.argv.indexOf("--company-defaults");
const defaults = await prepareCompanyDefaults({
  sourceFile: defaultsAt < 0 ? process.env.TUDA_COMPANY_DEFAULTS_FILE : process.argv[defaultsAt + 1],
  sourceJson: process.env.TUDA_COMPANY_DEFAULTS_JSON
}, path.resolve("tmp/release-config"));
function run(args) {
  const result = spawnSync("pnpm.cmd", args, { stdio: "inherit", shell: true, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["brand:check"]);
run(["build"]);
const { build, Platform, Arch } = await import("electron-builder");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
await build({ targets: Platform.WINDOWS.createTarget("nsis", Arch[arch]), publish: "never", config: {
  ...(arch === process.arch ? { electronDist: "node_modules/electron/dist" } : {}),
  extraResources: [...pkg.build.extraResources, { from: defaults.file, to: "company-defaults.json" }]
} });
run(["exec", "node", "scripts/verify-package-size.mjs", "--app-path", arch === "arm64" ? "release/win-arm64-unpacked" : "release/win-unpacked", "--report", `output/package-size/win-${arch}.json`, "--company-defaults", defaults.file]);
