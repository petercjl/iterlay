// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(() => ({status: {authenticated:true,activeSpace:"enterprise",connected:true,accountMode:"shared",user:{name:"钉钉测试姓名",avatarUrl:"https://static.dingtalk.com/test.png"},peers:[],textModels:3,imageModels:0}, select:vi.fn(async (space: string) => ({activeSpace:space})), login:vi.fn(), folder:vi.fn(), profile:vi.fn(async()=>({})), logout:vi.fn(async()=>({}))}));
vi.mock("../src/components/enterprise/use-enterprise", () => ({useEnterpriseStatus: () => mock.status}));
vi.mock("../src/lib/image-workbench-api", () => ({getImageWorkbenchApi: () => ({selectSpace:mock.select,beginEnterpriseLogin:mock.login,chooseCompanyLocalFolder:mock.folder,updateCompanyProfile:mock.profile,enterpriseLogout:mock.logout}),getWorkbenchErrorMessage:(e:Error) => e.message}));
vi.mock("sonner",()=>({toast:{warning:vi.fn(),success:vi.fn()}}));
import { GlobalAccountMenu } from "../src/components/enterprise/GlobalAccountMenu";
import { SpaceControl } from "../src/components/enterprise/SpaceControl";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>vi.clearAllMocks());
it("switches storage separately from global identity without login or a folder picker",async()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  await act(async()=>root.render(createElement(SpaceControl)));
  expect(container.textContent).not.toContain("钉钉测试姓名");expect(container.querySelector("img")).toBeNull();
  await act(async()=>container.querySelector("button")!.click());
  const radios=Array.from(document.querySelectorAll<HTMLButtonElement>("button[role=radio]"));expect(radios).toHaveLength(2);
  expect(radios[0].textContent).toContain("企业空间");expect(radios[1].textContent).toContain("本地空间");
  expect(document.body.textContent).not.toContain("选择公司本地文件夹");expect(document.body.textContent).not.toContain("使用钉钉登录企业空间");
  await act(async()=>radios[1].click());expect(mock.select).toHaveBeenCalledWith("personal");expect(mock.folder).not.toHaveBeenCalled();expect(mock.login).not.toHaveBeenCalled();
 } finally {await act(async()=>root.unmount());container.remove();}
});

it("shows the global DingTalk account, saves a nickname and offers logout",async()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  await act(async()=>root.render(createElement(GlobalAccountMenu)));
  const trigger=container.querySelector<HTMLButtonElement>("[data-global-account]")!;
  expect(trigger.getAttribute("aria-label")).toContain("钉钉测试姓名");
  expect(container.querySelector("img")!.getAttribute("src")).toBe(mock.status.user.avatarUrl);
  expect(container.querySelector("img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
  await act(async()=>trigger.click());
  const dialog=document.querySelector("[data-account-settings]")!;
  expect(dialog.textContent).toContain("钉钉：钉钉测试姓名");
  const input=dialog.querySelector<HTMLInputElement>("input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"我的昵称");input.dispatchEvent(new Event("input",{bubbles:true}));});
  const button=(label:string)=>Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent===label)!;
  await act(async()=>button("保存").click());expect(mock.profile).toHaveBeenCalledWith("我的昵称");
  expect(button("更新钉钉资料")).toBeTruthy();
  await act(async()=>button("退出登录").click());expect(mock.logout).toHaveBeenCalledOnce();
 }finally{await act(async()=>root.unmount());container.remove();}
 expect(document.documentElement.classList.contains("tuda-global-account-active")).toBe(false);
});
