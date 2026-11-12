import { spawnSync } from "node:child_process";
if (process.platform !== "win32") throw new Error("Build customer Windows installers on Windows; macOS uses electron:dev.");
const at = process.argv.indexOf("--arch");
const arch = at >= 0 ? process.argv[at + 1] : "x64";
if (!["x64", "arm64"].includes(arch)) throw new Error("Select --arch x64 or arm64.");
function run(args) {
  const result = spawnSync("pnpm.cmd", args, { stdio: "inherit", shell: true, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(["brand:check"]);
run(["build"]);
run(["exec", "electron-builder", "--win", "nsis", `--${arch}`, "--publish", "never"]);
run(["exec", "node", "scripts/verify-package-size.mjs", "--app-path", arch === "arm64" ? "release/win-arm64-unpacked" : "release/win-unpacked", "--report", `output/package-size/win-${arch}.json`]);
