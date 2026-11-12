import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildAssetArchive } from "../asset-archive.js";
import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import { executionContext, executionSpace, setSelectedSpaceResolver } from "../execution-space.js";
import { EnterpriseClient } from "./client.js";
import { setCommandRouter } from "../renderer-security.js";
import { flushWindow } from "../window-lifecycle.js";
import { ENTERPRISE_ASSET_PREFIX } from "../../shared/enterprise.js";
import { boardStoragePaths } from "../domain/board-model.js";
import type { SettingsStore } from "../storage/settings-store.js";
import type { BoardStore } from "../storage/board-store.js";
import type { AssetStore } from "../storage/asset-store.js";
import { buildBoardArchive, parseBoardArchive } from "../board-archive.js";
import type { BoardData } from "../../shared/types.js";
import type { CompanyDesktop } from "../company/desktop.js";

export async function createEnterpriseClient(userData: string) {
  const client = new EnterpriseClient(userData,
    async () => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && /^(https?:|file:)/.test(window.webContents.getURL())) await flushWindow(window); },
    boardId => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("workbench:event", { type: "board-updated", boardId, preserveView: true, collaboration: true }); });
  client.on("state", value => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("enterprise:state", value); });
  client.on("library-changed", () => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("workbench:event", { type: "library-updated" }); });
  client.on("space-changed", () => { setTimeout(() => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.reload(); }, 200); });
  setSelectedSpaceResolver(() => client.activeSpace);
  await client.initialize(); return client;
}

const providerFields = ["providers", "activeProviderId", "textProviders", "activeTextProviderId", "videoProviders", "activeVideoProviderId", "audioProviders", "activeAudioProviderId", "apiKeyByProviderId", "defaultCliBoardId", "memoryEnabled"];
export function enterpriseSettings(local: SettingsStore, client: EnterpriseClient, company?: CompanyDesktop): SettingsStore {
  const overlay = () => company?.enabled ? company.overlaySettings(local.getSettings()) : client.overlaySettings(local.getSettings());
  const managed = () => Boolean(company?.enabled && company.account.authenticated);
  return new Proxy(local, { get(target, property) {
    if (property === "getSettings") return () => managed() || executionSpace() === "enterprise" ? overlay() : target.getSettings();
    if (property === "getApiKey") return (id?: string) => managed() ? company!.token(id) : executionSpace() === "enterprise" ? company?.enabled ? company.token(id) : client.providerToken(id) : target.getApiKey(id);
    if (property === "getKeyStatus") return () => managed() ? Object.fromEntries([...overlay().providers,...overlay().textProviders].map(p=>[p.id,Boolean(company!.token(p.id))])) : executionSpace() === "enterprise" ? client.providerKeyStatus() : target.getKeyStatus();
    if (property === "hasSavedSettings") return () => managed() || executionSpace() === "enterprise" || target.hasSavedSettings();
    if (property === "saveSettings" || property === "updateSettings") return async (value: Record<string, unknown>) => {
      const next = { ...value };
      if (managed() || executionSpace() === "enterprise") {
        if(company?.enabled) await company.selectModels(value);
        const original = target.getSettings() as unknown as Record<string, unknown>;
        for (const key of providerFields) if (key in next) { if (property === "saveSettings") next[key] = original[key]; else delete next[key]; }
      }
      const result = await (property === "saveSettings" ? target.saveSettings(next as never) : target.updateSettings(next as never));
      return managed() || executionSpace() === "enterprise" ? overlay() : result;
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

function remapPaths(value: unknown, mapping: Map<string, string>): unknown {
  if (typeof value === "string") return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => remapPaths(item, mapping));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapPaths(item, mapping)]));
  return value;
}

export function registerEnterprise(client: EnterpriseClient, localBoards: BoardStore, assets: AssetStore, settings: SettingsStore, company?: CompanyDesktop) {
  ipcMain.handle("enterprise:status", () => company?.status ?? client.status);
  ipcMain.handle("enterprise:configure", (_event, url: string) => company ? company.configure(url) : client.configure(url));
  ipcMain.handle("enterprise:login", async () => { const login = await (company?.beginLogin() ?? client.beginLogin()); await shell.openExternal(login.authorizeUrl); return { expiresAt: login.expiresAt }; });
  ipcMain.handle("enterprise:loginPoll", () => company?.pollLogin() ?? client.pollLogin());
  ipcMain.handle("enterprise:logout", () => company?.logout() ?? client.logout());
  ipcMain.handle("enterprise:selectSpace", (_event, space) => company?.selectSpace(space) ?? client.selectSpace(space));
  ipcMain.handle("enterprise:localFolder", (_event,reuseExisting?:boolean) => {if(!company?.enabled) throw new Error("请先配置公司账号服务。");return company.chooseFolder(true,reuseExisting===true);});
  ipcMain.handle("enterprise:nasStorage", (_event,url:string) => {if(!company?.enabled)throw new Error("请先配置公司账号服务。");return company.chooseNas(url);});
  ipcMain.handle("enterprise:refreshModels", async () => {if(!company?.enabled)throw new Error("请先配置公司账号服务。");await company.account.refresh();return company.status;});
  ipcMain.handle("enterprise:presence", (_event, value) => { if(!company?.enabled||company.usesNas)client.updatePresence(value); });
  ipcMain.handle("enterprise:providerAccounts", (_event, userId: string) => client.providerAccounts(userId));
  ipcMain.handle("enterprise:assignProvider", (_event, value) => client.assignProvider(value));
  ipcMain.handle("enterprise:members", () => client.members());
  ipcMain.handle("enterprise:updateMember", (_event, value) => client.updateMember(value));
  ipcMain.handle("enterprise:undo", (_event, boardId: string, direction: "undo" | "redo") => client.undo(boardId, direction));
  ipcMain.handle("enterprise:retrySync", () => client.replayPending());
  const copy = async (id: string) => {
    if (executionSpace() !== "personal") throw new Error("请在个人空间选择要复制的画板。");
    const board = await localBoards.getBoard(id); if (!board) throw new Error("个人画板不存在。");
    await client.refreshIdentity();
    const mapping = new Map<string, string>();
    for (const file of boardStoragePaths(board)) {
      const uploaded = await client.command("asset:importUpload", [await assets.readManagedDataUrl(file)]); mapping.set(file, uploaded.path);
    }
    const created = await client.command("boards:create", [board.name]);
    await client.command("boards:get", [created.id]);
    return client.command("boards:save", [{ ...remapPaths(board, mapping) as BoardData, id: created.id, expectedRevision: 0 }]);
  };
  ipcMain.handle("enterprise:copyBoard", (_event, id: string) => copy(id));
  const routed = new Set(["boards:library:get", "boards:library:update", "boards:list", "boards:get", "boards:create", "boards:createComicDramaProject", "boards:save", "boards:rename", "boards:duplicate", "boards:delete", "boards:trash:list", "boards:trash:restore", "boards:trash:delete", "boards:trash:empty", "boards:images:move", "boards:images:resize", "boards:images:arrange", "boards:images:duplicate", "boards:images:setVersion", "boards:images:trash:list", "boards:images:trash:move", "boards:images:trash:restore", "boards:images:trash:delete", "boards:images:trash:empty", "boards:appendNodes", "boards:appendVersions", "boards:canvas:write", "boards:getState", "boards:setLastOpened", "asset:importUpload", "asset:readDataUrl", "asset:thumbnail", "image:generate", "image:cancel", "history:list", "history:scenes", "history:page", "assets:library", "assets:detail", "assets:item", "assets:jobPrompt"]);
  const dispose = setCommandRouter(async (_event, channel, args, next) => {
    if (channel.startsWith("enterprise:")) return next();
    if(company?.changingSpace && /^(boards:|asset:|image:generate)/.test(channel))throw new Error("正在切换空间，请等待画板重新打开。");
    if(company?.enabled){
      if(executionSpace()==="enterprise"){
        company.assertAccount();
        if (["settings:configureProvider", "provider:testConnection", "provider:listModels", "textProvider:testConnection", "textProvider:listModels", "videoProvider:testConnection", "videoProvider:listModels"].includes(channel)) throw new Error("公司模型由统一账号服务下发，请刷新模型授权。");
      }
      if(!company.usesNas||executionSpace()!=="enterprise"||/^(image|history|assistantConversation|assistant|textProvider):/.test(channel)) return next();
      // Auxiliary reads/recovery use account-scoped stores and the authorized
      // NAS board adapter. Unsupported operations stay behind the guard below.
      if (["comicDrama:getBoardSnapshot", "video:list", "video:recover", "comments:list", "sceneMedia:list", "templates:list", "templates:get"].includes(channel)) return next();
    }
    const hasEnterpriseAsset = args.some(value => typeof value === "string" && value.startsWith(ENTERPRISE_ASSET_PREFIX));
    const targetBoard = typeof args[0] === "string" ? args[0] : args[0] && typeof args[0] === "object" ? (args[0] as { boardId?: string; id?: string }).boardId ?? (args[0] as { id?: string }).id : undefined;
    const companyOperation = executionSpace() === "enterprise" || hasEnterpriseAsset || client.ownsBoard(targetBoard);
    if (!companyOperation) return next();
    if (channel === "boards:library:update" && (args[0] as { action?: { type?: string } })?.action?.type === "copy") for (const window of BrowserWindow.getAllWindows()) await flushWindow(window);
    if (routed.has(channel)) return client.command(channel, args);
    if (["settings:configureProvider", "provider:testConnection", "provider:listModels", "textProvider:testConnection", "textProvider:listModels", "videoProvider:testConnection", "videoProvider:listModels"].includes(channel)) throw new Error("企业模型由管理员在 NAS 服务端配置。");
    if (channel === "boards:export") {
      const board = await client.command("boards:get", [args[0]]);
      if (!board) throw new Error("画板不存在。");
      const buffer = await buildBoardArchive(board, [], app.getVersion(), [], [], [], [], async value => {
        const data = await client.command("asset:readDataUrl", [value]); return Buffer.from(String(data).split(",")[1], "base64");
      });
      const selection = await dialog.showSaveDialog({ title: "导出企业画板", defaultPath: `${String(board.name).replace(/[/\\]/g, "_")}.itb`, filters: [{ name: "Tuda 画板", extensions: ["itb"] }] });
      if (selection.canceled || !selection.filePath) return { ok: false };
      await writeFile(selection.filePath, buffer); return { ok: true, path: selection.filePath };
    }
    if (channel === "boards:import" || channel === "boards:importData") {
      let bytes: Buffer;
      if (channel === "boards:import") {
        const selection = await dialog.showOpenDialog({ title: "导入企业画板", filters: [{ name: "画板", extensions: ["itb", "irb"] }], properties: ["openFile"] });
        if (selection.canceled || !selection.filePaths[0]) return null;
        bytes = await readFile(selection.filePaths[0]);
      } else bytes = Buffer.from(args[0] as ArrayBuffer);
      const parsed = await parseBoardArchive(bytes), mapping = new Map<string, string>();
      for (const [name, data] of parsed.media) {
        const mime = name.toLowerCase().endsWith(".jpg") || name.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : name.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
        const uploaded = await client.command("asset:importUpload", [`data:${mime};base64,${data.toString("base64")}`]); mapping.set(name, uploaded.path);
      }
      const created = await client.command("boards:create", [parsed.board.name]); await client.command("boards:get", [created.id]);
      const saved = await client.command("boards:save", [{ ...remapPaths(parsed.board, mapping) as BoardData, id: created.id, expectedRevision: 0 }]);
      return { ...created, ...saved };
    }
    if (channel === "asset:save" || channel === "asset:saveBatch") {
      const paths = channel === "asset:save" ? [args[0]] : args[0];
      if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || paths.some(value => typeof value !== "string" || !value.startsWith(ENTERPRISE_ASSET_PREFIX))) throw new Error("请选择有效的企业图片。");
      let directory = settings.getSettings().downloadDirectory?.trim() || (executionContext().silent ? app.getPath("downloads") : undefined);
      if (!directory) {
        const choice = await dialog.showOpenDialog({ title: "选择下载文件夹", defaultPath: app.getPath("downloads"), properties: ["openDirectory", "createDirectory"] });
        if (choice.canceled || !choice.filePaths[0]) return { ok: false };
        directory = choice.filePaths[0]; settings.setDownloadDirectory(directory);
      }
      await mkdir(directory, { recursive: true });
      const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
      const items = [];
      for (const value of [...new Set(paths)]) {
        const data = String(await client.command("asset:readDataUrl", [value]));
        const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
        if (!match || !extensions[match[1]]) throw new Error("所选素材不是可下载的图片。");
        items.push({ sourcePath: value.slice(ENTERPRISE_ASSET_PREFIX.length) + "." + extensions[match[1]], bytes: Buffer.from(match[2], "base64") });
      }
      const filename = channel === "asset:save" ? "Tuda-" + items[0].sourcePath : "Tuda-images-" + randomUUID() + ".zip";
      let destination = path.join(directory, filename);
      if (await stat(destination).catch(() => null)) destination = path.join(directory, randomUUID() + "-" + filename);
      if (await stat(destination).catch(() => null)) throw new Error("下载目标已存在，请重试。");
      await writeFile(destination, channel === "asset:save" ? items[0].bytes : await buildAssetArchive(items), { flag: "wx" });
      return { ok: true, path: destination, directory, count: items.length, skippedCount: 0 };
    }
    if (/^(boards|asset|assets|image|video|audio|history|templates|sceneMedia|comments|modifications|imageDelivery|comicDrama):/.test(channel)) throw new Error("此操作尚未接入企业空间，未写入个人空间。");
    return next();
  });
  return () => { dispose(); company?.stop(); client.stop(); };
}
