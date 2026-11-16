import { expect, it } from "vitest";
import { CompanyAccount, validateBootstrap } from "../electron/company/account.js";
import { CompanyToapis } from "../electron/company/toapis.js";
import type { CompanyBootstrap, CompanySession } from "../shared/company-account.js";
import type { ProviderGenerateInput } from "../shared/types.js";

const origin = "https://account.example";
const session: CompanySession = { contract: 1, appId: "tuda", accountKind: "password", sessionId: "guest-session", token: "device-token",
  expiresAt: new Date(Date.now()+86400000).toISOString(), member: {id:"guest-id",name:"Guest"},organization:{id:"guests",name:"Guests"} };
const bootstrap: CompanyBootstrap = { contract:1,appId:"tuda",sessionId:session.sessionId,configVersion:"guest-config",member:session.member,organization:session.organization,
  text:{enabled:true,transport:"proxy",defaultModel:"text/main",providers:[{id:"text",name:"Text",protocol:"openai-responses",baseUrl:origin+"/api/company/v1/proxy/tuda/text/v1",models:[{id:"main",name:"Main"}]}]},
  image:{enabled:true,adapter:"company-proxy",models:["gemini-nano-banana-2.1"]},storage:{enabled:false} };

it("authenticates password accounts and refreshes without requesting provider secrets",async()=>{
  const routes:string[]=[];
  const account = new CompanyAccount(origin,async()=>{},async(input,init)=>{
    const route=new URL(String(input)).pathname;routes.push(route);
    const data=route.endsWith("/auth/password")?{...session,status:"authorized"}:route.endsWith("/session")?{...session,authenticated:true}:bootstrap;
    if(route.endsWith("/auth/password"))expect(JSON.parse(String(init?.body))).toEqual({appId:"tuda",username:"Guest",password:"12345678"});
    return Response.json({ok:true,data});
  });
  await account.passwordLogin("Guest","12345678");
  expect(account.authenticated).toBe(true);expect(account.directModels).toBeUndefined();expect(routes.some(route=>route.endsWith("/direct-models"))).toBe(false);
  expect(JSON.stringify(account.status)).not.toContain("device-token");
});
it("can log out and log in again using the same account client", async () => {
  let logins=0, logouts=0;
  const account=new CompanyAccount(origin,async()=>{},async input=>{
    const route=new URL(String(input)).pathname;
    if(route.endsWith("/auth/password"))logins++;
    if(route.endsWith("/logout"))logouts++;
    return Response.json({ok:true,data:route.endsWith("/bootstrap")?bootstrap:route.endsWith("/auth/password")?{...session,status:"authorized"}:{...session,authenticated:true}});
  });
  await account.passwordLogin("Guest","12345678");await account.logout();expect(account.authenticated).toBe(false);
  await account.passwordLogin("Guest","12345678");expect(account.authenticated).toBe(true);
  expect(logins).toBe(2);expect(logouts).toBe(1);
});
it("reports safe network causes without leaking the original error message", async () => {
  const account=new CompanyAccount(origin,async()=>{},async()=>{throw Object.assign(new Error("private-request-details"),{cause:{code:"ECONNRESET"}});});
  const error=await account.passwordLogin("Guest","12345678").catch(value=>value);
  expect(error).toMatchObject({code:"COMPANY_NETWORK_UNAVAILABLE",networkCode:"ECONNRESET"});
  expect(error.message).not.toContain("private-request-details");
});
it("rejects proxy credentials, NAS grants and a proxy assigned to an employee session",()=>{
  expect(validateBootstrap(bootstrap,session,origin).image.adapter).toBe("company-proxy");
  expect(()=>validateBootstrap({...bootstrap,storage:{enabled:true}},session,origin)).toThrow();
  expect(()=>validateBootstrap({...bootstrap,image:{...bootstrap.image,credential:{schemaVersion:1,site:"cn",apiKey:"secret"}}},session,origin)).toThrow();
  expect(()=>validateBootstrap(bootstrap,{...session,accountKind:undefined},origin)).toThrow();
});
it("routes guest images through the service without importing any local ToAPIs credential",async()=>{
  let localCalls=0;let received:unknown;
  const adapter=new CompanyToapis("unused",()=>({namespace:"guest",image:bootstrap.image}),async()=>{localCalls++;throw Error("must not use local Key");},undefined,async input=>{received=input;return {images:[]};});
  await adapter.testConnection();
  await adapter.generate({workflowMode:"generate",clientRequestId:"guest-request-123",model:"gemini-nano-banana-2.1",prompt:"Scene",size:"9:16",n:1,quality:"high",referenceImages:[]} satisfies ProviderGenerateInput);
  expect(localCalls).toBe(0);expect(received).toMatchObject({requestId:"guest-request-123",resolution:"2K",aspect:"9:16",references:[]});
});
