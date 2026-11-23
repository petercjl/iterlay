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

it("rejects an old guest session presented at the configured issuer", async () => {
  const account = new CompanyAccount(origin, async () => {});
  await expect(account.restore({ origin, session, bootstrap })).rejects.toThrow("公司设备授权格式无效");
  expect(account.authenticated).toBe(false);
});
it("reports safe network causes without leaking the original error message", async () => {
  const account=new CompanyAccount(origin,async()=>{},async()=>{throw Object.assign(new Error("private-request-details"),{cause:{code:"ECONNRESET"}});});
  const error=await account.beginLogin().catch(value=>value);
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
