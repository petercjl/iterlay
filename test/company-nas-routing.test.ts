import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { app, ipcMain, shell } from "electron";
import type { AssetStore } from "../electron/storage/asset-store.js";
import { SettingsStore } from "../electron/storage/settings-store.js";
import type { EnterpriseClient } from "../electron/enterprise/client.js";
const hooks = vi.hoisted(() => ({ send: vi.fn(), windows: [] as Array<{isDestroyed:()=>boolean; webContents:{send: (...args: unknown[])=>void}}>, router: undefined as undefined | ((event: never, channel: string, args: unknown[], next: () => unknown) => unknown) }));
vi.mock("electron", () => ({
  app: { get isPackaged() { return false; }, getApplicationNameForProtocol: vi.fn() }, shell: { openExternal: vi.fn() }, ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => hooks.windows }, dialog: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() }
}));
vi.mock("../electron/renderer-security.js", () => ({ setCommandRouter: (router: typeof hooks.router) => { hooks.router = router; return () => { hooks.router = undefined; }; } }));
import { CompanyDesktop } from "../electron/company/desktop.js";
import { EnterpriseClient as NasClient } from "../electron/enterprise/client.js";
import { createEnterpriseClient, enterpriseSettings, registerEnterprise } from "../electron/enterprise/integration.js";
import { OpenAICompatibleTextTransport } from "../electron/providers/text-assistant.js";
import { inExecutionSpace } from "../electron/execution-space.js";
import { BoardStore as LocalBoardStore } from "../electron/storage/board-store.js";
import { TemplateStore } from "../electron/storage/template-store.js";

it("persists local relay settings per company member and keeps same-name text models on their own credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-account-models-"));
  const client = new NasClient(root, async () => undefined, async () => undefined);
  const company = new CompanyDesktop(root, client, { accountOrigin: "https://company.example" });
  const global = new SettingsStore(path.join(root, "workspace"));
  const login = (id: string) => company.account.restore({ origin: company.account.origin, session: {
    contract: 1, appId: "tuda", sessionId: id, token: "session-" + id,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    member: { id, name: id }, organization: { id: "org", name: "公司" }
  } });
  const textProviders = ["relay-a", "relay-b"].map(id => ({
    id, name: id, type: "openai-compatible" as const, baseUrl: `https://${id}.example/v1`,
    model: "shared-model", protocol: "openai-chat-completions" as const
  }));
  const videoProvider = {
    id: "video-toapis", name: "ToAPIs", type: "seedance-toapis" as const,
    baseUrl: "https://video.example/v1", model: "seedance-2"
  };
  try {
    await company.initialize();
    await login("employee-a");
    const settings = enterpriseSettings(global, client, company);
    await settings.transaction(async () => {
      await settings.updateSettings({ textProviders, activeTextProviderId: "relay-b", videoProviders: [videoProvider] });
      for (const provider of textProviders) settings.setApiKey(provider.id, "key-" + provider.id);
      settings.setApiKey(videoProvider.id, "employee-a-video-key");
    });
    const reopened = enterpriseSettings(global, client, company);
    expect(reopened.getSettings().activeTextProviderId).toBe("relay-b");
    const fetchText = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      choices: [{ message: { content: "ok" } }]
    }));
    for (const provider of reopened.getSettings().textProviders) {
      expect(provider.protocol).toBe("openai-chat-completions");
      const transport = new OpenAICompatibleTextTransport(provider, reopened.getApiKey(provider.id), fetchText);
      await expect(transport.complete([{ role: "user", content: "hi" }], {})).resolves.toBe("ok");
    }
    expect(fetchText.mock.calls.map(([url, init]) => [url, new Headers(init?.headers).get("Authorization")])).toEqual(
      textProviders.map(provider => [provider.baseUrl + "/chat/completions", "Bearer key-" + provider.id])
    );
    expect(global.getApiKey("relay-a")).toBe("");
    expect(global.getApiKey(videoProvider.id)).toBe("");
    expect(reopened.getKeyStatus()[videoProvider.id]).toBe(true);
    expect(reopened.resolveVideoProviderConnection(videoProvider)).toEqual({
      baseUrl: videoProvider.baseUrl, apiKey: "employee-a-video-key", connectionProviderId: videoProvider.id
    });
    await login("employee-b");
    expect(reopened.getSettings().textProviders.some(provider => provider.id === "relay-a")).toBe(false);
    expect(reopened.getApiKey("relay-a")).toBe("");
    expect(reopened.resolveVideoProviderConnection(videoProvider).apiKey).toBe("");
    await login("employee-a");
    expect(reopened.getApiKey("relay-a")).toBe("key-relay-a");
  } finally {
    company.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  [false, "shanhai-omni-dev"],
  [true, "shanhai-omni"],
])("routes Shanhai authorization to the installed handler for packaged=%s", async (packaged, scheme) => {
  const client = Object.assign(new EventEmitter(), { stop: vi.fn() }) as unknown as EnterpriseClient;
  const requestId = "r".repeat(43);
  const authorizeUrl = "https://auth.lumyne.cn/api/company/v1/auth/authorize?request=" + requestId;
  const desktopUrl = scheme + "://authorize?request=" + requestId;
  const isPackaged = vi.spyOn(app, "isPackaged", "get").mockReturnValue(packaged);
  const beginLogin = vi.fn(async () => ({ requestId, authorizeUrl, expiresAt: "fixture", userCode: "RRRRRRRR" }));
  const pollLogin = vi.fn().mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "authorized" });
  const company = {
    beginLogin, pollLogin, stop: vi.fn(), account: { pendingBrowserAuthorization: () => authorizeUrl },
  } as unknown as CompanyDesktop;
  const foreground = vi.fn();
  const handlers = vi.mocked(ipcMain.handle);
  handlers.mockClear();
  const handler = (channel: string) => handlers.mock.calls.find(([name]) => name === channel)![1];
  const findApp = vi.mocked(app.getApplicationNameForProtocol);
  const open = vi.mocked(shell.openExternal);
  findApp.mockReturnValue("Shanhai Omni Dev");
  open.mockClear();
  const dispose = registerEnterprise(client, {} as LocalBoardStore, {} as AssetStore, {} as SettingsStore, company, foreground);
  try {
    const login = handler("enterprise:login");
    await expect(login({} as never)).resolves.toMatchObject({ surface: "desktop" });
    expect(open).toHaveBeenLastCalledWith(desktopUrl);
    await expect(login({} as never, { useBrowser: true })).resolves.toEqual({ surface: "browser" });
    expect(open).toHaveBeenLastCalledWith(authorizeUrl);
    expect(beginLogin).toHaveBeenCalledOnce();
    await handler("enterprise:loginPoll")({} as never);
    expect(foreground).not.toHaveBeenCalled();
    await handler("enterprise:loginPoll")({} as never);
    expect(foreground).toHaveBeenCalledOnce();

    findApp.mockReturnValue("");
    await expect(login({} as never)).resolves.toMatchObject({ surface: "browser" });
    expect(open).toHaveBeenLastCalledWith(authorizeUrl);
    findApp.mockReturnValue("Shanhai Omni Dev");
    open.mockRejectedValueOnce(new Error("Could not open protocol"));
    await expect(login({} as never)).resolves.toMatchObject({ surface: "browser" });
    expect(open).toHaveBeenLastCalledWith(authorizeUrl);
  } finally {
    isPackaged.mockRestore();
    dispose();
  }
});

it("reads assistant context from the authorized NAS board and scoped auxiliary stores without allowing unsupported mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-nas-context-"));
  const command = vi.fn();
  const legacy = Object.assign(new EventEmitter(), { status: { pendingWrites: 0 }, stop: vi.fn(), command, ownsBoard: () => false }) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, { accountOrigin: "https://company.example", nasUrl: "https://nas.example" });
  let dispose: (() => void) | undefined;
  try {
    await company.initialize();
    await company.account.restore({ origin: company.account.origin, session: {
      contract: 1, appId: "tuda", sessionId: "device", token: "fixture-token", expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      member: { id: "employee", name: "员工" }, organization: { id: "org", name: "公司" }
    } });
    const personal = new LocalBoardStore(path.join(root, "personal"));
    const board = await personal.createBoard("NAS board fixture");
    command.mockResolvedValue({ ...board, revision: 12 });
    const localRead = vi.spyOn(personal, "getComicDramaBoardSnapshot");
    const boards = company.nasBoards(personal);
    await inExecutionSpace(async () => {
      expect(await boards.getComicDramaBoardSnapshot(board.id)).toEqual({ boardId: board.id, revision: 12, nodes: [], connections: [], groups: [] });
      expect(command).toHaveBeenCalledWith("boards:get", [board.id]);
      expect(localRead).not.toHaveBeenCalled();
      command.mockResolvedValueOnce(null);
      await expect(boards.getComicDramaBoardSnapshot("missing")).rejects.toThrow("画板不存在");
      command.mockRejectedValueOnce(new Error("NAS read denied"));
      await expect(boards.getComicDramaBoardSnapshot(board.id)).rejects.toThrow("NAS read denied");
    }, "enterprise");
    command.mockImplementation(async (channel: string) => channel === "boards:list" ? [{id:board.id}] : {...board,revision:12});
    await inExecutionSpace(async()=>expect(await boards.listBoards()).toEqual([expect.objectContaining({id:board.id})]),"enterprise");
    const personalTemplates = new TemplateStore(path.join(root, "templates.json"));
    await personalTemplates.create({ name: "Private template", prompt: "Personal instructions" });
    const templates = company.scopeStore(personalTemplates, workspace => new TemplateStore(path.join(workspace, "templates.json")));
    expect(await inExecutionSpace(() => templates.list(), "enterprise")).toEqual([]);
    expect(await inExecutionSpace(() => templates.list(), "personal")).toHaveLength(1);
    dispose = registerEnterprise(legacy, boards, {} as AssetStore, {} as SettingsStore, company);
    await inExecutionSpace(async () => {
      for (const channel of ["comicDrama:getBoardSnapshot", "video:list", "video:recover", "comments:list", "sceneMedia:list", "templates:list", "templates:get", "assets:detail", "assets:jobPrompt"]) {
        const next = vi.fn().mockResolvedValue("scoped-result");
        expect(await hooks.router!(undefined as never, channel, [], next)).toBe("scoped-result");
        expect(next).toHaveBeenCalledOnce();
      }
      const next = vi.fn();
      await expect(hooks.router!(undefined as never, "comicDrama:applyMutationPlan", [], next)).rejects.toThrow("未写入个人空间");
      expect(next).not.toHaveBeenCalled();
    }, "enterprise");
  } finally { dispose?.(); company.stop(); await rm(root, { recursive: true, force: true }); }
});

it("keeps the shared account identity on every NAS board observation state event", async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"tuda-nas-login-state-"));
 const initialize=vi.spyOn(NasClient.prototype,"initialize").mockResolvedValue();
 hooks.windows=[{isDestroyed:()=>false,webContents:{send:hooks.send}}];
 const legacy=await createEnterpriseClient(root);
 const company=new CompanyDesktop(root,legacy,{accountOrigin:"https://company.example",nasUrl:"https://nas.example"});
 let dispose:(()=>void)|undefined;
 try {
  await company.initialize();await company.account.restore({origin:company.account.origin,session:{contract:1,appId:"tuda",sessionId:"device",token:"fixture",expiresAt:new Date(Date.now()+86400000).toISOString(),member:{id:"employee",name:"Employee"},organization:{id:"org",name:"Company"}}});
  dispose=registerEnterprise(legacy,{} as LocalBoardStore,{} as AssetStore,{} as SettingsStore,company);
  hooks.send.mockClear();
  for(const connected of [true,false,true]) legacy.emit("state",{authenticated:true,connected,peers:[]});
  const events=hooks.send.mock.calls.filter(([channel])=>channel==="enterprise:state");
  expect(events).toHaveLength(3);
  for(const [,status] of events) expect(status).toMatchObject({accountMode:"shared",authenticated:true,user:{name:"Employee"}});
 }finally{dispose?.();company.stop();legacy.stop();initialize.mockRestore();hooks.windows=[];await rm(root,{recursive:true,force:true});}
});
