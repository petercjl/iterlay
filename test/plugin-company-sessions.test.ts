import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";import path from "node:path";
vi.mock("electron", () => ({ BrowserWindow:{getAllWindows:()=>[]},dialog:{showOpenDialog:vi.fn()},safeStorage:{isEncryptionAvailable:()=>true,encryptString:(v:string)=>Buffer.from(v),decryptString:(v:Buffer)=>v.toString()} }));
import { dialog } from "electron";
import { CompanyDesktop, scopedCompany } from "../electron/company/desktop.js";
import { BoardPluginSessions } from "../electron/company/plugin-sessions.js";
import { executionContext, setSelectedSpaceResolver, setExecutionDetailsResolver } from "../electron/execution-space.js";
import type { EnterpriseClient } from "../electron/enterprise/client.js";
const origin="https://account.example.test";
const session=(id:string)=>({contract:1 as const,appId:"tuda" as const,sessionId:"session-"+id,token:"private-"+id,expiresAt:new Date(Date.now()+86400000).toISOString(),member:{id,name:id},organization:{id:"org",name:"company"}});
const bootstrap=(id:string)=>({contract:1 as const,appId:"tuda" as const,sessionId:"session-"+id,configVersion:"1",member:session(id).member,organization:session(id).organization,text:{enabled:false,providers:[],defaultModel:null},image:{enabled:false,models:[],reason:"BOARD_ONLY_SESSION"},storage:{enabled:false,reason:"LOCAL"}});
const legacy=()=>Object.assign(new EventEmitter(),{activeSpace:"personal",status:{pendingWrites:0},stop:vi.fn()}) as unknown as EnterpriseClient;
it("two host accounts stay connection-scoped across awaits and store adapters while desktop identity/preferences remain intact",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"tuda-session-isolation-")),desktop=scopedCompany(new CompanyDesktop(root,legacy(),{accountOrigin:origin}));let revoked=false;
 vi.stubGlobal("fetch",vi.fn(async(url: string|URL|Request,init?:RequestInit)=>{
  const route=String(url).split("/api/company/v1")[1];let id=String(new Headers(init?.headers).get("authorization")||"").replace("Bearer private-","");
  if(route==="/handoff/exchange"){const body=JSON.parse(String(init?.body));id=body.code[0]==="b"?"B":"C";return Response.json({ok:true,data:{...session(id),status:"authorized"}});}
  if(revoked&&id==="B")return Response.json({ok:false,error:{code:"AUTH_REQUIRED",message:"revoked"}},{status:401});
  return Response.json({ok:true,data:route==="/session"?{...session(id),authenticated:true}:bootstrap(id)});
 }));
 const sessions=new BoardPluginSessions((grant)=>desktop.createPluginConnection(grant,legacy()));
 try{
  await desktop.initialize();await desktop.account.restore({origin,session:session("A")});
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({canceled:false,filePaths:[path.join(root,"desktop-workspace")]});await desktop.chooseFolder(false);
  await writeFile(path.join(root,"company-session.json"),"desktop-owned-private-session",{flag:"wx",mode:0o600});
  const before=await Promise.all(["company-session.json","company-workspaces.json"].map(n=>readFile(path.join(root,n),"utf8"))),uiNamespace=desktop.namespace,uiSpace=desktop.activeSpace;
  const store=desktop.scopeStore({root:"personal"},workspace=>({root:workspace}));
  const grant=(id:string)=>({contract:1,origin,appId:"tuda",instanceId:"a".repeat(64),code:id.repeat(43),verifier:"v".repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()});
  await sessions.accept("b".repeat(64),grant("b"));await sessions.accept("c".repeat(64),grant("c"));
  const seen=await Promise.all(["b","c"].map(key=>sessions.run(key.repeat(64),async()=>{await Promise.resolve();await new Promise(r=>setTimeout(r,3));return {member:desktop.account.session?.member.id,namespace:desktop.namespace,context:executionContext().account,root:store.root};})));
  expect(seen.map(v=>v.member)).toEqual(["B","C"]);for(const v of seen){expect(v.context).toBe(v.namespace);expect(v.root).toContain(v.namespace!);expect(v.root).not.toContain("desktop-workspace");}
  expect(desktop.account.session?.member.id).toBe("A");expect(desktop.namespace).toBe(uiNamespace);expect(desktop.activeSpace).toBe(uiSpace);
  expect(await Promise.all(["company-session.json","company-workspaces.json"].map(n=>readFile(path.join(root,n),"utf8")))).toEqual(before);
  const operation=vi.fn(async()=>"should not run");revoked=true;await expect(sessions.run("b".repeat(64),operation)).rejects.toThrow();expect(operation).not.toHaveBeenCalled();expect(desktop.account.session?.member.id).toBe("A");
  await expect(sessions.run("d".repeat(64),operation)).rejects.toThrow("AUTH_HANDOFF_REQUIRED");expect(operation).not.toHaveBeenCalled();
 }finally{sessions.stop();desktop.stop();vi.unstubAllGlobals();setSelectedSpaceResolver(()=>"personal");setExecutionDetailsResolver(()=>({}));await rm(root,{recursive:true,force:true});}
});
