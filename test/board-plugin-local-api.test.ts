import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import {createHash} from "node:crypto";
import {BoardPluginSessions} from "../electron/company/plugin-sessions.js";
import {executionContext} from "../electron/execution-space.js";
import path from "node:path";
const mocks = vi.hoisted(() => ({ flush: vi.fn(async () => undefined), getBoardsState: vi.fn(async () => ({ lastOpenedBoardId: "foreground" })), moveBoardImage: vi.fn(async () => ({ ok: true })), createBoard: vi.fn(async () => ({ id: "silent-board", name: "silent" })), getBoard: vi.fn(async () => ({ id: "silent-board", nodes: [] })), saveAssetsAsZip: vi.fn(async () => ({ ok: true, path: "/downloads/test.zip" })), getSettings: vi.fn(async () => ({ activeProviderId: "" })), listBoards: vi.fn(async () => []), enterpriseStatus: vi.fn(async () => ({ authenticated: true, activeSpace: "enterprise" })) }));
vi.mock("../electron/application/workbench-api.js", () => ({ createMainWorkbenchApi: () => mocks }));
vi.mock("../electron/window-lifecycle.js", () => ({ flushWindow: mocks.flush }));
import { startLocalApi } from "../electron/local-api.js";

it("enforces the server capability boundary, private auth and per-call company validation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-plugin-api-"));
  const grant = vi.fn(async () => ({ authenticated: true }));
  const authorize = vi.fn(async () => undefined);
  const quit = vi.fn(async () => undefined);
  vi.stubEnv("TUDA_PLUGIN_SPACE", "enterprise");
  const dispose = await startLocalApi({ isDestroyed: () => false, webContents: {} } as never, directory, () => undefined, grant, authorize, quit);
  const info = JSON.parse(await readFile(path.join(directory, "local-api.json"), "utf8"));
  const call = async (route: string, body: unknown, token = info.token) => fetch(`http://127.0.0.1:${info.port}${route}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    expect((await call("/board-plugin/call", { method: "list_boards", args: {} }, "wrong")).status).toBe(401);
    expect((await call("/board-plugin/call", { method: "generate_image", args: {} })).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
    expect((await call("/board-plugin/call", { method: "list_boards", args: { space: "personal" } })).status).toBe(400);
    vi.stubEnv("TUDA_EMBEDDED_HOST", "codex-own");
    expect((await call("/board-plugin/auth", { contract: 1, code: "private" })).status).toBe(200);
    expect(grant).toHaveBeenCalledWith({ contract: 1, code: "private" });
    vi.stubEnv("TUDA_EMBEDDED_HOST", "");
    expect((await call("/board-plugin/host/quit", {})).status).toBe(400);
    expect(quit).not.toHaveBeenCalled();
    vi.stubEnv("TUDA_EMBEDDED_HOST", "codex-own");
    expect((await call("/board-plugin/host/quit", {})).status).toBe(200);
    expect(quit).toHaveBeenCalledOnce();
    expect((await call("/board-plugin/call", { method: "list_boards", args: {} })).status).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    mocks.listBoards.mockClear();
    authorize.mockRejectedValue(new Error("PARENT_SESSION_REVOKED"));
    expect((await call("/board-plugin/call", { method: "list_boards", args: {} })).status).toBe(400);
    expect(mocks.listBoards).not.toHaveBeenCalled();
  } finally { dispose(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});

it("requires a private connection grant, pins enterprise scope, advertises live compatibility and never falls back after revocation",async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),"tuda-plugin-connections-"));let revoked=false;const seen:string[]=[];
 const sessions=new BoardPluginSessions(async()=>({namespace:"plugin-user",workspace:directory,storage:{kind:"local"},account:{authenticated:true},authorizeHostOperation:async()=>{expect(executionContext().account).toBe("plugin-user");if(revoked)throw Error("PARENT_REVOKED");},legacy:{stop:()=>undefined},stop:()=>undefined} as never));
 const dispose=await startLocalApi({isDestroyed:()=>false,webContents:{}} as never,directory,undefined,undefined,undefined,undefined,{sessions,desktopVersion:"0.1.0"});
 const info=JSON.parse(await readFile(path.join(directory,"local-api.json"),"utf8")),instanceId=createHash("sha256").update(`${info.port}\0${info.token}`).digest("hex"),secret="b".repeat(64);
 const call=(route:string,body:unknown,key?:string)=>fetch(`http://127.0.0.1:${info.port}${route}`,{method:"POST",headers:{authorization:`Bearer ${info.token}`,"content-type":"application/json",...(key?{"x-tuda-plugin-session":key}:{})},body:JSON.stringify(body)});
 try{
  const ready=await (await call("/call",{method:"status",args:{}})).json();expect(ready.result.boardPlugin).toMatchObject({contract:1,authScope:"connection",preservesDesktopSession:true});expect(ready.result.desktopVersion).toBe("0.1.0");
  expect((await call("/board-plugin/auth",{instanceId:"wrong"},secret)).status).toBe(400);
  expect((await call("/board-plugin/auth",{instanceId})).status).toBe(400);
  expect((await call("/board-plugin/auth",{instanceId},secret)).status).toBe(200);
  mocks.listBoards.mockImplementation(async()=>{seen.push(executionContext().account||"desktop");return [];});
  expect((await call("/board-plugin/call",{method:"list_boards",args:{}},secret)).status).toBe(200);expect(seen).toEqual(["plugin-user"]);
  expect((await call("/board-plugin/call",{method:"list_boards",args:{space:"personal"}},secret)).status).toBe(400);
  expect((await call("/board-plugin/call",{method:"list_boards",args:{}},"c".repeat(64))).status).toBe(400);
  revoked=true;expect((await call("/board-plugin/call",{method:"list_boards",args:{}},secret)).status).toBe(400);expect(seen).toEqual(["plugin-user"]);
 }finally{dispose();sessions.stop();await rm(directory,{recursive:true,force:true});}
});

it("defaults external calls to silent context and passive events, showing only explicit successful view calls", async () => {
 const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-silent-api-"));
 const show = vi.fn(), send = vi.fn();
 const dispose = await startLocalApi({ isDestroyed: () => false, webContents: { send } } as never, directory, show);
 const info = JSON.parse(await readFile(path.join(directory, "local-api.json"), "utf8"));
 const call = async (method: string, args = {}) => {
   const response = await fetch(`http://127.0.0.1:${info.port}/call`, { method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, args }) });
   return { status: response.status, body: await response.json() };
 };
 try {
   mocks.createBoard.mockImplementation(async () => { expect(executionContext().silent).toBe(true); return { id: "silent-board", name: "silent" }; });
   await call("create_board", { name: "silent", preserveView: false });
   expect(send).toHaveBeenCalledWith("workbench:event", expect.objectContaining({ type: "board-created", preserveView: true }));
   mocks.saveAssetsAsZip.mockImplementation(async () => { expect(executionContext().silent).toBe(true); return { ok: true, path: "/downloads/test.zip" }; });
   expect((await call("export_assets", { paths: ["test"] })).body.result.ok).toBe(true);
   expect(show).not.toHaveBeenCalled();
   mocks.flush.mockClear();
   await call("move_image", { boardId: "background", nodeId: "image", x: 10, y: 20 });
   expect(mocks.flush).not.toHaveBeenCalled();
   await call("move_image", { boardId: "foreground", nodeId: "image", x: 10, y: 20 });
   expect(mocks.flush).toHaveBeenCalledOnce();
   expect(executionContext().silent).toBeUndefined();
   await call("open_board", { boardId: "silent-board" });
   expect(show).toHaveBeenCalledOnce();
   mocks.getBoard.mockRejectedValueOnce(new Error("missing"));
   expect((await call("open_board", { boardId: "missing" })).status).toBe(400);
   expect(show).toHaveBeenCalledOnce();
 } finally { dispose(); await rm(directory, { recursive: true, force: true }); }
});
