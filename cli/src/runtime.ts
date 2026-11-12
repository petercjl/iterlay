import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { callLocalApi } from "../../electron/local-api-client.js";
import { resolveTudaApp } from "./paths.js";
import { CLI_BACKGROUND_FLAG } from "../../electron/background-session.js";
export interface RuntimeOptions { userDataPath: string; appRoot?: string; noLaunch?: boolean; startupTimeoutMs?: number }
export async function desktopInstance(userDataPath: string): Promise<string> {
  let info: { port: number; token: string };
  try { info = JSON.parse(await readFile(path.join(userDataPath, "local-api.json"), "utf8")); }
  catch { throw new Error("INVALID_LOCAL_BRIDGE"); }
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(info.token)) throw new Error("INVALID_LOCAL_BRIDGE");
  return createHash("sha256").update(`${info.port}\0${info.token}`).digest("hex");
}
export async function prepareDesktop(options: RuntimeOptions) {
  const call = await connect(options);
  const state = await call("status") as { protocolVersion?: number };
  return { ready: true, instanceId: await desktopInstance(options.userDataPath), protocolVersion: state.protocolVersion };
}
export async function connect(options: RuntimeOptions): Promise<(method: string, args?: Record<string, unknown>) => Promise<unknown>> {
  const startupTimeoutMs = options.startupTimeoutMs ?? Number(process.env.TUDA_STARTUP_TIMEOUT_MS ?? 30000);
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 180000) throw new Error("INVALID_STARTUP_TIMEOUT: expected 1000..180000 milliseconds");
  const call = (method: string, args: Record<string, unknown> = {}) => callLocalApi(options.userDataPath, method, args);
  try { await call("status"); return call; } catch (error) {
    if (options.noLaunch) throw error;
  }
  const app = await resolveTudaApp(options.appRoot);
  if (!app) throw new Error("未找到 Tuda App，请先安装并打开 App，或指定 --app-path。");
  const child = spawn(app.commandPath, [CLI_BACKGROUND_FLAG], { detached: true, stdio: "ignore", windowsHide: true, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")) });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  const startupDeadline = Date.now() + startupTimeoutMs;
  while (Date.now() < startupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { await call("status"); return call; } catch { /* Readiness probes only; never retry mutations. */ }
  }
  throw new Error("Tuda 后台服务尚未就绪，请检查运行日志，或手动打开 App 后重试。");
}
