import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccount } from "../electron/company/account.js";
import { directTextProviders, validateDirectModels } from "../electron/company/direct-models.js";
import { OpenAICompatibleTextTransport } from "../electron/providers/text-assistant.js";
import type { CompanyBootstrap, CompanyDirectModels, CompanySession } from "../shared/company-account.js";

const origin = "https://account.example.test";
function fixture() {
  const session: CompanySession = {contract:1,appId:"tuda",sessionId:"fixture-session",token:"cdev_private-fixture-token",
    expiresAt:new Date(Date.now()+86400000).toISOString(),member:{id:"employee",name:"Employee"},organization:{id:"org",name:"Company"}};
  const direct: CompanyDirectModels = {contract:2,appId:"tuda",sessionId:session.sessionId,authenticated:true,expiresAt:session.expiresAt,member:session.member,organization:session.organization,transport:"direct",subject:"a".repeat(64),configVersion:"b".repeat(64),model:"gateway/deepseek",
    provider:{gateway:{name:"Model provider",wire_api:"responses",options:{baseURL:"https://models.example.test/v1",apiKey:"upstream-private-fixture-key"},models:{deepseek:{name:"DeepSeek",limit:{context:128000,output:16384}}}}}};
  const bootstrap: CompanyBootstrap = {contract:1,appId:"tuda",sessionId:session.sessionId,member:session.member,organization:session.organization,configVersion:"bootstrap-config",
    text:{enabled:true,defaultModel:"gateway/deepseek",providers:[{id:"gateway",name:"Model provider",protocol:"openai-responses",baseUrl:origin+"/api/company/v1/proxy/tuda/gateway/v1",models:[{id:"deepseek",name:"DeepSeek"}]}]},
    image:{enabled:false,models:[]},storage:{enabled:true,audience:"tuda-nas",scopes:["boards:read","assets:read"]}};
  let offline = false, denied = false, mismatch = false;
  const requests: Array<{url:string;headers:Headers}> = [], saved: unknown[] = [];
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    requests.push({url:String(url),headers:new Headers(init?.headers)});
    if (offline) throw Error("offline");
    if (denied) return Response.json({ok:false,error:{code:"ACCESS_DENIED"}},{status:403});
    const route = String(url).split("/api/company/v1")[1];
    if (route === "/logout") return Response.json({ok:true,data:{contract:1,appId:"tuda",revoked:true}});
    if (route === "/storage/token") return Response.json({ok:true,data:{contract:1,appId:"tuda",token:"csto_storage-only",tokenType:"Bearer",audience:"tuda-nas",memberId:session.member.id,organizationId:session.organization.id,scopes:bootstrap.storage.scopes,expiresAt:new Date(Date.now()+300000).toISOString()}});
    return Response.json({ok:true,data:route === "/session" ? {...session,authenticated:true,token:undefined,subject:direct.subject,configVersion:mismatch?"c".repeat(64):direct.configVersion,authorization:{validForSeconds:300,refreshAfterSeconds:120}}
      : route === "/direct-models" ? direct : bootstrap});
  }) as unknown as typeof fetch;
  const account = new CompanyAccount(origin, async value => { saved.push(structuredClone(value)); }, fetcher);
  return {account,session,direct,bootstrap,requests,saved,setOffline:(v=true)=>{offline=v;},setDenied:()=>{denied=true;},setMismatch:()=>{mismatch=true;}};
}

const accounts: CompanyAccount[] = [];
beforeEach(() => {vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));});
afterEach(() => {for(const account of accounts.splice(0)) account.stopAuthorization();vi.useRealTimers();});

describe("Tuda direct text authorization", () => {
  it("migrates a proxy session to direct configuration, keeps device credentials on company routes and preserves NAS", async () => {
    const f = fixture(); accounts.push(f.account);
    await f.account.restore({origin,session:f.session,bootstrap:f.bootstrap});
    await f.account.refresh();
    const config = directTextProviders(f.account.directModels!)[0];
    const model = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer upstream-private-fixture-key");
      expect(headers.has("X-Company-App-Id")).toBe(false);
      return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"直连成功"}]}]});
    });
    const transport = new OpenAICompatibleTextTransport(config,"managed-direct-text",f.account.textFetch(config,model as typeof fetch));
    expect(await transport.complete([{role:"user",content:"test"}],{})).toBe("直连成功");
    expect(model.mock.calls[0][0]).toBe("https://models.example.test/v1/responses");
    expect(f.requests.every(r=>r.headers.get("authorization")==="Bearer "+f.session.token)).toBe(true);
    expect(f.requests.every(r=>!r.url.includes("/proxy/"))).toBe(true);
    expect(JSON.stringify(f.account.status)).not.toContain("upstream-private");
    expect(JSON.stringify(directTextProviders(f.account.directModels!))).not.toContain("upstream-private");
    expect(JSON.stringify(await transport.getAgentConnection().getAuth())).not.toContain("X-Company-App-Id");
    expect(JSON.stringify(await transport.getAgentConnection().getAuth())).not.toContain("upstream-private");
    expect((await f.account.storageToken()).token).toBe("csto_storage-only");
  });
  it("uses only an unexpired 300 second online lease during a network failure and aborts active streams at expiry", async () => {
    const f = fixture();accounts.push(f.account);await f.account.restore({origin,session:f.session});await f.account.refresh();
    const model = vi.fn(async (_input: unknown, init?: RequestInit) => {return Response.json({aborted:init?.signal?.aborted});});
    const run = f.account.textFetch(directTextProviders(f.direct)[0],model as typeof fetch);
    await run("https://models.example.test/v1/responses");
    const signal = model.mock.calls[0][1]?.signal;
    f.setOffline();await vi.advanceTimersByTimeAsync(121000);
    await expect(run("https://models.example.test/v1/responses")).resolves.toBeInstanceOf(Response);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(180000);
    expect(signal?.aborted).toBe(true);
    await expect(run("https://models.example.test/v1/responses")).rejects.toThrow("续验失败");
    expect(model).toHaveBeenCalledTimes(2);
  });
  it.each(["revocation","configuration"])("cancels in-flight requests on %s and rejects stale transports", async kind => {
    const f = fixture();accounts.push(f.account);await f.account.restore({origin,session:f.session});await f.account.refresh();
    let signal: AbortSignal | null | undefined;
    const run = f.account.textFetch(directTextProviders(f.direct)[0],(async (_url,init)=>{signal=init?.signal;return Response.json({});}) as typeof fetch);
    await run("https://models.example.test/v1/responses");
    if(kind==="revocation") f.setDenied();else f.setMismatch();
    await expect(f.account.refresh()).rejects.toThrow();expect(signal?.aborted).toBe(true);
    await expect(run("https://models.example.test/v1/responses")).rejects.toThrow();
    if(kind==="revocation") expect(f.account.authenticated).toBe(false);
  });
  it("stops local authorization before awaiting logout and requires online verification after restoration", async () => {
    const f=fixture();accounts.push(f.account);await f.account.restore({origin,session:f.session});await f.account.refresh();
    const restored=fixture();accounts.push(restored.account);
    await restored.account.restore(f.saved.at(-1) as never);restored.setOffline();
    const blocked=restored.account.textFetch(directTextProviders(restored.direct)[0],vi.fn() as typeof fetch);
    await expect(blocked("https://models.example.test/v1/responses")).rejects.toThrow();
    const model=vi.fn(async()=>Response.json({}));const run=f.account.textFetch(directTextProviders(f.direct)[0],model as typeof fetch);
    const logout=f.account.logout();await expect(run("https://models.example.test/v1/responses")).rejects.toThrow();await logout;expect(model).not.toHaveBeenCalled();
  });
  it("rejects malicious or cross-identity direct configuration and off-endpoint requests", async () => {
    const f=fixture();accounts.push(f.account);
    for (const mutate of [
      (d:CompanyDirectModels)=>{d.appId="codex-own" as never;},
      (d:CompanyDirectModels)=>{d.subject="x";},
      (d:CompanyDirectModels)=>{d.sessionId="other";},
      (d:CompanyDirectModels)=>{d.provider.gateway.options.baseURL=origin+"/api/company/v1/proxy/tuda/gateway/v1";},
      (d:CompanyDirectModels)=>{d.provider.gateway.options.apiKey=f.session.token;},
      (d:CompanyDirectModels)=>{d.provider.gateway.options.baseURL="http://insecure.example/v1";},
      (d:CompanyDirectModels)=>{d.model="gateway/unknown";}
    ]) {const d=structuredClone(f.direct);mutate(d);expect(()=>validateDirectModels(d,f.session,origin)).toThrow();}
    await f.account.restore({origin,session:f.session});await f.account.refresh();const model=vi.fn() as typeof fetch;
    const run=f.account.textFetch(directTextProviders(f.direct)[0],model);
    await expect(run("https://elsewhere.example/v1/responses")).rejects.toThrow("偏离");
    expect(model).not.toHaveBeenCalled();
  });
});
