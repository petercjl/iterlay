import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");

export function desktopLaunchPlan(root, listeners) {
  if (listeners.length === 0) return "start";
  if (listeners.every(({ cwd, command }) => cwd === root && /(?:^|\/)vite(?:\.js)?\s.*--port 5180(?:\s|$)/.test(command))) return "reuse";
  throw new Error("Tuda 开发端口 5180 被其他服务占用，请先检查占用程序。");
}

export function inspectListeners() {
  let output;
  try {
    output = execFileSync("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:5180", "-sTCP:LISTEN"], { encoding: "utf8" });
  } catch (error) {
    if (error.status === 1 && !error.stdout?.toString().trim()) return [];
    throw error;
  }
  return [...new Set(output.trim().split(/\s+/))].map(pid => {
    const command = execFileSync("/bin/ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim();
    const cwd = execFileSync("/usr/sbin/lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" })
      .split("\n").find(line => line.startsWith("n"))?.slice(1);
    return { command, cwd };
  });
}

export async function launchDesktopDev() {
  const mode = desktopLaunchPlan(projectRoot, inspectListeners());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (mode === "reuse") {
    const response = await fetch("http://127.0.0.1:5180/@vite/client", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Tuda 开发服务未就绪，请检查开发服务日志。");
    env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5180";
  }
  const child = mode === "reuse"
    ? spawn(process.execPath, [path.join(projectRoot, "scripts/run-desktop-electron.mjs"), "."], { cwd: projectRoot, env, stdio: "inherit" })
    : spawn("pnpm", ["electron:dev"], { cwd: projectRoot, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", error => { console.error(error); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launchDesktopDev();
}
