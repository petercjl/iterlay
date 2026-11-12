import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { inExecutionSpace } from "./execution-space.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Command = (event: IpcMainInvokeEvent, args: unknown[]) => unknown;
const commands = new Map<string, Command>();
const messages = new Map<string, ((event: IpcMainEvent, args: unknown[]) => unknown)[]>();
type CommandRouter = (event: IpcMainInvokeEvent, channel: string, args: unknown[], next: (args?: unknown[]) => unknown) => unknown;
let commandRouter: CommandRouter | undefined;
export function setCommandRouter(router: CommandRouter): () => void {
  commandRouter = router;
  return () => { if (commandRouter === router) commandRouter = undefined; };
}

export function isTrustedRendererUrl(url: string, appFile: string, developmentUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return path.resolve(fileURLToPath(parsed)) === path.resolve(appFile);
    if (!developmentUrl) return false;
    const expected = new URL(developmentUrl);
    return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
  } catch { return false; }
}

export function installRendererSecurity(appFile: string, developmentUrl?: string): void {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const guarded = (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.senderFrame !== event.sender.mainFrame
        || !isTrustedRendererUrl(event.senderFrame?.url ?? "", appFile, developmentUrl)) {
        throw new Error("不允许非应用页面调用桌面服务。");
      }
      return invokeRegisteredCommand(event, channel, args);
    };
    commands.set(channel, (event, args) => listener(event, ...args));
    originalHandle(channel, guarded);
  };
  const originalOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, listener) => {
    const listeners = messages.get(channel) ?? [];
    listeners.push((event, args) => listener(event, ...args));
    messages.set(channel, listeners);
    return originalOn(channel, (event, ...args: unknown[]) => {
      if (event.senderFrame !== event.sender.mainFrame
        || !isTrustedRendererUrl(event.senderFrame?.url ?? "", appFile, developmentUrl)) return;
      inExecutionSpace(() => listener(event, ...args));
    });
  };
  app.on("will-quit", () => { commands.clear(); messages.clear(); });
}

/** Only trusted main-process adapters call this; renderer calls use guarded IPC. */
export async function invokeRegisteredCommand(event: IpcMainInvokeEvent, channel: string, args: unknown[]): Promise<unknown> {
  const command = commands.get(channel);
  if (!command) throw new Error(`未注册的应用命令：${channel}`);
  return inExecutionSpace(() => commandRouter ? commandRouter(event, channel, args, (replacement = args) => command(event, replacement)) : command(event, args));
}

/** Authenticated local development adapters use the same message handlers as IPC. */
export function sendRegisteredMessage(event: IpcMainEvent, channel: string, args: unknown[]): void {
  const listeners = messages.get(channel);
  if (!listeners?.length) throw new Error(`未注册的应用消息：${channel}`);
  for (const listener of listeners) inExecutionSpace(() => listener(event, args));
}

export function allowedExternalUrl(input: string): boolean {
  try { return ["https:", "http:", "mailto:"].includes(new URL(input).protocol); }
  catch { return false; }
}
