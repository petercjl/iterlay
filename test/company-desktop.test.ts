import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}));
import { dialog, net, safeStorage } from "electron";
import { CompanyDesktop } from "../electron/company/desktop.js";
import type { EnterpriseClient } from "../electron/enterprise/client.js";
import { CompanyToapis } from "../electron/company/toapis.js";
import type { CompanyBootstrap, CompanyDirectModels, CompanySession } from "../shared/company-account.js";

it("switches an existing deployment to Omni and reuses only explicitly linked employee settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-omni-migration-"));
  const legacy = Object.assign(new EventEmitter(), {
    activeSpace: "personal", status: { pendingWrites: 0 }, stop: vi.fn(),
  }) as unknown as EnterpriseClient;
  const accountOrigin = "https://legacy.example", omniOrigin = "http://127.0.0.1:8248";
  const company = new CompanyDesktop(root, legacy, { legacyWorkspaceOrigin: accountOrigin, omniOrigin });
  const session: CompanySession = {
    contract: 1, appId: "tuda", sessionId: "employee-session", token: "employee-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    member: { id: "legacy-member", name: "Employee" },
    organization: { id: "legacy-org", name: "Enterprise" },
  };
  const snapshot = Buffer.from(JSON.stringify({ origin: accountOrigin, session })).toString("base64");
  const namespace = createHash("sha256")
    .update(JSON.stringify([accountOrigin, session.organization.id, session.member.id])).digest("hex");
  try {
    await writeFile(path.join(root, "company-session.json"), JSON.stringify({ version: 1, encrypted: snapshot }), { flag: "wx" });
    await writeFile(path.join(root, "company-workspaces.json"), JSON.stringify({
      version: 1, origin: accountOrigin, activeSpace: "enterprise", folders: {}, selections: {},
      profiles: { [namespace]: { nickname: "Previous nickname" } },
    }), { flag: "wx" });
    const withoutOmni = new CompanyDesktop(root, legacy, { accountOrigin });
    try {
      await withoutOmni.initialize();
      expect(withoutOmni.status.authenticated).toBe(false);
      await expect(withoutOmni.beginLogin()).rejects.toThrow("山海账号服务尚未配置");
    } finally {
      withoutOmni.stop();
    }
    await company.initialize();
    expect(company.status).toMatchObject({
      serverUrl: omniOrigin, accountProvider: "omni", authenticated: false,
    });
    await company.account.restore({ origin: omniOrigin, session });
    expect(company.namespace).not.toBe(namespace);
    expect(company.status.accountNickname).toBeUndefined();
    await company.account.restore({ origin: omniOrigin, session: { ...session, legacyWorkspace: true } });
    expect(company.namespace).toBe(namespace);
    expect(company.status.accountNickname).toBe("Previous nickname");
    await expect(company.selectSpace("enterprise")).rejects.toThrow("仅开放本地空间");
  } finally {
    company.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("opens authorization only on Omni even when an old account origin is configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-omni-guest-"));
  const legacy = Object.assign(new EventEmitter(), {
    activeSpace: "personal", status: { pendingWrites: 0 }, stop: vi.fn(),
  }) as unknown as EnterpriseClient;
  const accountOrigin = "https://guests.example", omniOrigin = "http://127.0.0.1:8248";
  const company = new CompanyDesktop(root, legacy, { accountOrigin, omniOrigin });
  const requestId = "v".repeat(43);
  const fetch = vi.mocked(net.fetch);
  fetch.mockResolvedValueOnce(Response.json({ ok: true, data: {
    contract: 1, appId: "tuda", requestId, userCode: "VVVVVVVV",
    verificationUrl: `${omniOrigin}/api/company/v1/auth/authorize?request=${requestId}`,
    expiresIn: 120, intervalMs: 1000,
  } }));
  try {
    const login = await company.beginLogin();
    expect(login).toMatchObject({ userCode: "VVVVVVVV" });
    expect(fetch).toHaveBeenCalledWith(omniOrigin + "/api/company/v1/auth/start", expect.objectContaining({
      body: expect.not.stringContaining("password"),
    }));
  } finally {
    company.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("disconnects a changed enterprise storage source and only reconnects to the current route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-omni-storage-"));
  const useStorageSession = vi.fn(async (_url: string, refresh: () => Promise<unknown>) => { await refresh(); });
  const stop = vi.fn();
  const legacy = Object.assign(new EventEmitter(), {
    activeSpace: "personal", status: { pendingWrites: 0 }, stop, useStorageSession,
  }) as unknown as EnterpriseClient;
  const omniOrigin = "https://omni.example";
  const company = new CompanyDesktop(root, legacy, { omniOrigin, nasUrl: "http://custom-nas.test" });
  const session: CompanySession = {
    contract: 1, appId: "tuda", sessionId: "employee-session", token: "employee-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    member: { id: "employee", name: "Employee" }, organization: { id: "org", name: "Company" },
  };
  const bootstrap: CompanyBootstrap = {
    contract: 1, appId: "tuda", sessionId: session.sessionId, member: session.member, organization: session.organization,
    configVersion: "fixture", text: { enabled: false, defaultModel: null, providers: [] },
    image: { enabled: false, models: [] }, storage: { enabled: false },
  };
  const grant = vi.spyOn(company.account, "storageToken").mockResolvedValue({
    token: "independent-storage-token", scopes: ["boards:read"], expiresAt: session.expiresAt,
  });
  try {
    await company.initialize();
    const restore = (storage: CompanyBootstrap["storage"]) =>
      company.account.restore({ origin: omniOrigin, session, bootstrap: { ...bootstrap, storage } });
    await restore({ enabled: true, mode: "hosted", endpoint: "https://hosted.example" });
    await company.selectSpace("enterprise");
    expect(company.status).toMatchObject({ activeSpace: "enterprise", storageSource: "hosted" });
    expect(useStorageSession.mock.calls[0][0]).toBe("https://hosted.example");
    stop.mockClear();
    await restore({ enabled: true, mode: "self-hosted", endpoint: "https://self-hosted.example" });
    expect(stop).toHaveBeenCalledOnce();
    expect(() => company.assertNasAccess()).toThrow("重新连接");
    await expect(useStorageSession.mock.calls[0][1]()).rejects.toThrow("来源已更改");
    expect(grant).toHaveBeenCalledOnce();
    await company.selectSpace("enterprise");
    expect(useStorageSession.mock.calls[1][0]).toBe("https://self-hosted.example");
    expect(company.status.storageSource).toBe("self-hosted");
    await expect(company.chooseNas("http://custom-nas.test")).rejects.toThrow("山海管理员");
    await restore({ enabled: false });
    expect(() => company.assertNasAccess()).toThrow("未获企业存储授权");
    await company.selectSpace("personal");
    expect(company.status).toMatchObject({ activeSpace: "personal", enterpriseStorageAuthorized: false });
  } finally {
    company.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("opens the workspace only after the initial Omni storage choice is ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-omni-login-"));
  const origin = "https://omni.example";
  let finishConnection!: () => void;
  const pending = new Promise<void>(resolve => { finishConnection = resolve; });
  const useStorageSession = vi.fn(() => pending);
  const legacy = Object.assign(new EventEmitter(), {
    status: { pendingWrites: 0 }, stop: vi.fn(), useStorageSession,
  }) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, { omniOrigin: origin });
  const session: CompanySession = {
    contract: 1, appId: "tuda", sessionId: "device", token: "fixture",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    member: { id: "employee", name: "Employee" }, organization: { id: "org", name: "Company" },
  };
  vi.spyOn(company.account, "pollLogin").mockImplementation(async () => {
    await company.account.restore({ origin, session, bootstrap: {
      contract: 1, appId: "tuda", sessionId: session.sessionId, member: session.member, organization: session.organization,
      configVersion: "fixture", text: { enabled: false, defaultModel: null, providers: [] },
      image: { enabled: false, models: [] }, storage: { enabled: true, mode: "hosted", endpoint: "https://storage.example" },
    } });
    return { status: "authorized" };
  });
  try {
    await company.initialize();
    const login = company.pollLogin();
    await vi.waitFor(() => expect(useStorageSession).toHaveBeenCalledOnce());
    expect(company.status.authenticated).toBe(false);
    expect(company.activeSpace).toBe("personal");
    finishConnection();
    await expect(login).resolves.toEqual({ status: "authorized" });
    expect(company.status).toMatchObject({ authenticated: true, activeSpace: "enterprise" });
  } finally {
    finishConnection();
    company.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("uses the Electron network stack for account requests", async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),"tuda-account-network-"));
 const legacy=Object.assign(new EventEmitter(),{activeSpace:"personal",status:{pendingWrites:0},stop:vi.fn()}) as unknown as EnterpriseClient;
 const company=new CompanyDesktop(root,legacy,{accountOrigin:"https://company.example"});
 const requestId="r".repeat(43);
 vi.mocked(net.fetch).mockResolvedValueOnce(Response.json({ok:true,data:{contract:1,appId:"tuda",requestId,verificationUrl:`https://company.example/api/company/v1/auth/authorize?request=${requestId}`,expiresIn:600,intervalMs:2000,userCode:requestId.slice(0,8).toUpperCase()}}));
 try {
  expect((await company.account.beginLogin()).authorizeUrl).toContain(requestId);
  expect(net.fetch).toHaveBeenCalledWith("https://company.example/api/company/v1/auth/start",expect.objectContaining({method:"POST",redirect:"error"}));
 } finally {company.stop();await rm(root,{recursive:true,force:true});}
});

it("leaves the old guest session file intact and starts on the Omni login screen",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"tuda-guest-desktop-"));
 const legacy=Object.assign(new EventEmitter(),{activeSpace:"enterprise",status:{pendingWrites:0,serverUrl:"https://nas.example"},stop:vi.fn()}) as unknown as EnterpriseClient;
 const company=new CompanyDesktop(root,legacy,{accountOrigin:"https://company.example",omniOrigin:"https://omni.example"});
 const session:CompanySession={contract:1,appId:"tuda",accountKind:"password",sessionId:"device",token:"fixture",expiresAt:new Date(Date.now()+86400000).toISOString(),member:{id:"guest-one",name:"Guest"},organization:{id:"guests",name:"Guests"}};
 try{
  const saved = JSON.stringify({ version: 1, encrypted: Buffer.from(JSON.stringify({
    origin: "https://company.example", session,
  })).toString("base64") });
  const file = path.join(root, "company-session.json");
  await writeFile(file, saved, { flag: "wx", mode: 0o600 });
  await company.initialize();
  expect(company.status).toMatchObject({ authenticated: false, serverUrl: "https://omni.example", activeSpace: "personal" });
  expect(await readFile(file, "utf8")).toBe(saved);
 }finally{company.stop();await rm(root,{recursive:true,force:true});}
});

it("projects direct models without exposing Keys through settings, status or generic credential access", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"tuda-direct-desktop-"));
  const legacy=Object.assign(new EventEmitter(),{activeSpace:"personal",status:{pendingWrites:0},stop:vi.fn()}) as unknown as EnterpriseClient;
  const company=new CompanyDesktop(root,legacy,{accountOrigin:"https://company.example"});
  const session:CompanySession={contract:1,appId:"tuda",sessionId:"session",token:"device-private-fixture",expiresAt:new Date(Date.now()+86400000).toISOString(),member:{id:"employee",name:"Employee"},organization:{id:"org",name:"Company"}};
  const direct:CompanyDirectModels={contract:2,appId:"tuda",sessionId:"session",authenticated:true,expiresAt:session.expiresAt,member:session.member,organization:session.organization,transport:"direct",subject:"a".repeat(64),configVersion:"b".repeat(64),model:"dashscope/deepseek",provider:{dashscope:{name:"DashScope",wire_api:"responses",options:{baseURL:"https://provider.example/v1",apiKey:"real-provider-private-fixture"},models:{deepseek:{name:"DeepSeek",limit:{context:128000,output:16000}}}}}};
  try {
    await company.initialize();
    await company.account.restore({origin:company.account.origin,session,directModels:direct,bootstrap:{contract:1,appId:"tuda",sessionId:"session",member:session.member,organization:session.organization,configVersion:"1",text:{enabled:true,defaultModel:"dashscope/deepseek",providers:[{id:"dashscope",name:"DashScope",protocol:"openai-responses",baseUrl:"https://company.example/api/company/v1/proxy/tuda/dashscope/v1",models:[{id:"deepseek",name:"DeepSeek"}]}]},image:{enabled:false,models:[]},storage:{enabled:false}}});
    const settings=company.overlaySettings({} as import("../shared/types.js").AppSettings);
    expect(settings.textProviders[0]).toMatchObject({transport:"company-direct",managed:true,baseUrl:"https://provider.example/v1"});
    expect(company.token(settings.activeTextProviderId)).toBe("managed-direct-text");
    expect(JSON.stringify(settings)).not.toContain("real-provider-private");
    expect(JSON.stringify(company.status)).not.toContain("real-provider-private");
    expect(settings.activeTextProviderId).toBe("company-text/dashscope/deepseek");
  } finally {company.stop();await rm(root,{recursive:true,force:true});}
});

it.each(["", "https://custom-company.example"])("fills empty account settings from deployment defaults and preserves explicit settings (%s)", async (savedOrigin) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-company-upgrade-"));
  const legacy = Object.assign(new EventEmitter(), { activeSpace: "personal", status: { pendingWrites: 0 }, stop: vi.fn() }) as unknown as EnterpriseClient;
  const preferences = { version: 1, origin: savedOrigin, activeSpace: "personal", folders: {}, selections: {} };
  const file = path.join(root, "company-workspaces.json");
  await writeFile(file, JSON.stringify(preferences), { flag: "wx" });
  const company = new CompanyDesktop(root, legacy, { accountOrigin: "https://company.example", nasUrl: "http://nas.example:18473" });
  try {
    await company.initialize();
    expect(company.status).toMatchObject({ accountMode: "shared", serverUrl: savedOrigin || "https://company.example", storageUrl: "http://nas.example:18473" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(preferences);
  } finally { company.stop(); await rm(root, { recursive: true, force: true }); }
});

it("uses NAS for enterprise storage and switches spaces without another company login", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-nas-only-"));
  const useStorageSession = vi.fn(async () => undefined);
  const legacy = Object.assign(new EventEmitter(), {activeSpace: "personal", status: {pendingWrites: 0, connected: true}, stop: vi.fn(), useStorageSession}) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, {accountOrigin: "https://company.example", nasUrl: "https://nas.example"});
  try {
    await company.initialize();
    await company.account.restore({origin: company.account.origin, session: {contract: 1, appId: "tuda", sessionId: "device", token: "fixture", expiresAt: new Date(Date.now()+86400000).toISOString(), member: {id: "member", name: "Employee"}, organization: {id: "org", name: "Company"}}});
    const login = vi.spyOn(company.account, "beginLogin");
    vi.mocked(dialog.showOpenDialog).mockClear();
    await company.selectSpace("enterprise"); expect(company.activeSpace).toBe("enterprise");
    expect(company.workspace).toContain("company-cache");
    await company.selectSpace("personal");expect(company.activeSpace).toBe("personal");
    await company.selectSpace("enterprise");
    expect(login).not.toHaveBeenCalled();expect(useStorageSession).toHaveBeenCalledTimes(2);
    await expect(company.chooseFolder()).rejects.toThrow("企业空间固定使用 NAS");
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  } finally {company.stop();await rm(root,{recursive:true,force:true});}
});
it("preserves legacy company folder data while enterprise routing uses NAS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-legacy-company-folder-"));
  const legacy = Object.assign(new EventEmitter(), {activeSpace: "personal", status: {pendingWrites: 0}, stop: vi.fn()}) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, {accountOrigin: "https://company.example", nasUrl: "https://nas.example"});
  try {
    await company.initialize();await company.account.restore({origin: company.account.origin, session: {contract: 1, appId: "tuda", sessionId: "device", token: "fixture", expiresAt: new Date(Date.now()+86400000).toISOString(), member: {id: "member", name: "Employee"}, organization: {id: "org", name: "Company"}}});
    const preferences = (company as unknown as {preferences: {folders: Record<string,string>;storage: Record<string,{kind: "local"}>}}).preferences;
    preferences.folders[company.namespace!] = path.join(root,"legacy-folder");preferences.storage ??= {};preferences.storage[company.namespace!] = {kind: "local"};
    expect(company.folder).toBe(path.join(root,"legacy-folder"));expect(company.workspace).toContain("company-cache");
    expect(company.status.localFolder).toBeUndefined();expect(company.storage).toEqual({kind: "nas",url:"https://nas.example"});
  } finally {company.stop();await rm(root,{recursive:true,force:true});}
});
it("automatically validates a newly granted image credential and disables it on entitlement removal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-auto-image-auth-"));
  const check = vi
    .spyOn(CompanyToapis.prototype, "testConnection")
    .mockResolvedValue();
  const legacy = Object.assign(new EventEmitter(), {
    activeSpace: "personal",
    status: { pendingWrites: 0 },
    stop: vi.fn(),
  }) as unknown as EnterpriseClient;
  const previous = process.env.TUDA_COMPANY_URL;
  let company: CompanyDesktop | undefined;
  try {
    process.env.TUDA_COMPANY_URL = "https://company.example";
    company = new CompanyDesktop(root, legacy);
    await company.initialize();
    const member = { id: "employee", name: "员工" },
      organization = { id: "organization", name: "公司" };
    const session = {
      contract: 1 as const,
      appId: "tuda" as const,
      sessionId: "device",
      token: "fixture-device",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      member,
      organization,
    };
    const bootstrap = {
      contract: 1 as const,
      appId: "tuda" as const,
      sessionId: "device",
      configVersion: "1",
      member,
      organization,
      text: { enabled: false, defaultModel: null, providers: [] },
      image: {
        enabled: true,
        adapter: "toapiscli" as const,
        package: "@petercjl/toapiscli" as const,
        credential: {
          schemaVersion: 1 as const,
          site: "cn" as const,
          apiKey: "fixture-private-image-key",
        },
        models: ["gpt-image-2.6-sunburst"],
      },
      storage: { enabled: false },
    };
    await company.account.restore({
      origin: company.account.origin,
      session,
      bootstrap,
    });
    await vi.waitFor(() => expect(company?.status.imageConfigured).toBe(true));
    expect(check).toHaveBeenCalledOnce();
    expect(company.token("company-image/gpt-image-2.6-sunburst")).toBe(
      "managed-toapis",
    );
    expect(JSON.stringify(company.status)).not.toContain(
      "fixture-private-image-key",
    );
    await company.account.restore({
      origin: company.account.origin,
      session,
      bootstrap: {
        ...bootstrap,
        configVersion: "2",
        image: { enabled: false, reason: "IMAGE_NOT_GRANTED", models: [] },
      },
    });
    expect(company.status.imageConfigured).toBe(false);
    expect(company.token("company-image/gpt-image-2.6-sunburst")).toBe("");
  } finally {
    company?.stop();
    check.mockRestore();
    if (previous === undefined) delete process.env.TUDA_COMPANY_URL;
    else process.env.TUDA_COMPANY_URL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps embedded grants memory-only and never restores a prior host through the OS keychain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-embedded-session-"));
  const legacy = Object.assign(new EventEmitter(), { activeSpace: "personal", status: { pendingWrites: 0 }, stop: vi.fn() }) as unknown as EnterpriseClient;
  const decrypt = vi.spyOn(safeStorage, "decryptString"), encrypt = vi.spyOn(safeStorage, "encryptString");
  vi.stubEnv("TUDA_EMBEDDED_HOST", "codex-own");
  const company = new CompanyDesktop(root, legacy, { accountOrigin: "https://company.example" });
  try {
    await writeFile(path.join(root, "company-session.json"), JSON.stringify({ version: 1, encrypted: "legacy-host-grant" }), { flag: "wx", mode: 0o600 });
    await company.initialize();
    expect(company.status.authenticated).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
    await company.account.configure("https://company.example");
    expect(encrypt).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(root, "company-session.json"), "utf8")).encrypted).toBe("legacy-host-grant");
  } finally { company.stop(); decrypt.mockRestore(); encrypt.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("completes company login independently of offline NAS and without a folder picker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-offline-login-"));
  const legacy = Object.assign(new EventEmitter(), {activeSpace: "personal", status: {pendingWrites: 0}, stop: vi.fn(), useStorageSession: vi.fn(async () => {throw new Error("NAS offline");})}) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, {omniOrigin: "https://omni.example"});
  try {
    await company.initialize();
    const session: CompanySession = {contract: 1, appId: "tuda", sessionId: "device", token: "fixture", expiresAt: new Date(Date.now()+86400000).toISOString(), member: {id: "member", name: "Employee"}, organization: {id: "org", name: "Company"}};
    await company.account.restore({ origin: company.account.origin, session, bootstrap: {
      contract: 1, appId: "tuda", sessionId: session.sessionId, member: session.member, organization: session.organization,
      configVersion: "fixture", text: { enabled: false, defaultModel: null, providers: [] },
      image: { enabled: false, models: [] }, storage: { enabled: true, mode: "nas", endpoint: "https://nas.example" },
    } });
    vi.spyOn(company.account, "pollLogin").mockResolvedValue({status: "authorized"});
    vi.mocked(dialog.showOpenDialog).mockClear();
    expect(await company.pollLogin()).toEqual({status: "authorized"});
    expect(company.status.authenticated).toBe(true);expect(company.activeSpace).toBe("personal");
    expect(company.status.storageError).toContain("企业空间连接失败");
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  } finally {company.stop(); await rm(root, {recursive:true,force:true});}
});

it("persists a Tuda nickname per company account while preserving DingTalk identity",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"tuda-nickname-"));
 const legacy=Object.assign(new EventEmitter(),{activeSpace:"personal",status:{pendingWrites:0},stop:vi.fn()}) as unknown as EnterpriseClient;
 const company=new CompanyDesktop(root,legacy,{accountOrigin:"https://company.example"});
 const session={contract:1 as const,appId:"tuda" as const,sessionId:"device",token:"fixture",expiresAt:new Date(Date.now()+86400000).toISOString(),member:{id:"member",name:"DingTalk Name"},organization:{id:"org",name:"Company"}};
 try{
  await company.initialize();await company.account.restore({origin:company.account.origin,session});
  await company.updateProfile("  Tuda Nickname  ");expect(company.status.accountNickname).toBe("Tuda Nickname");expect(company.status.user?.name).toBe("DingTalk Name");
  const saved=JSON.parse(await readFile(path.join(root,"company-workspaces.json"),"utf8"));expect(saved.profiles[company.namespace!].nickname).toBe("Tuda Nickname");
  await expect(company.updateProfile("x".repeat(41))).rejects.toThrow();
  await company.account.restore({origin:company.account.origin,session:{...session,member:{id:"another",name:"Other"}}});expect(company.status.accountNickname).toBeUndefined();
  await company.account.restore({origin:company.account.origin,session});expect(company.status.accountNickname).toBe("Tuda Nickname");
  await company.updateProfile("");expect(company.status.accountNickname).toBeUndefined();
 }finally{company.stop();await rm(root,{recursive:true,force:true});}
});
