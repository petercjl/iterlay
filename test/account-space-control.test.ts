// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mock=vi.hoisted(() => ({status: {authenticated:true,activeSpace:"enterprise",connected:true,accountMode:"shared",user:{name:"山海测试姓名",avatarUrl:"https://static.dingtalk.com/test.png"},peers:[],textModels:3,imageModels:0}, select:vi.fn(async (space: string) => ({activeSpace:space})), login:vi.fn(), folder:vi.fn(), profile:vi.fn(async()=>({})), refresh:vi.fn(async()=>({})), logout:vi.fn(async()=>({}))}));
vi.mock("../src/components/enterprise/use-enterprise", () => ({useEnterpriseStatus: () => mock.status}));
vi.mock("../src/lib/image-workbench-api", () => ({getImageWorkbenchApi: () => ({selectSpace:mock.select,beginEnterpriseLogin:mock.login,chooseCompanyLocalFolder:mock.folder,updateCompanyProfile:mock.profile,refreshCompanyModels:mock.refresh,enterpriseLogout:mock.logout}),getWorkbenchErrorMessage:(e:Error) => e.message}));
vi.mock("sonner",()=>({toast:{warning:vi.fn(),success:vi.fn()}}));
import { GlobalAccountMenu } from "../src/components/enterprise/GlobalAccountMenu";
import { SpaceControl } from "../src/components/enterprise/SpaceControl";
import { AccountSettingsPanel } from "../src/components/workbench/settings/AccountSettingsPanel";
import type { EnterpriseStatus } from "../shared/enterprise";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>vi.clearAllMocks());
it("switches storage separately from global identity without login or a folder picker",async()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  await act(async()=>root.render(createElement(SpaceControl)));
  expect(container.textContent).not.toContain("山海测试姓名");expect(container.querySelector("img")).toBeNull();
  await act(async()=>container.querySelector("button")!.click());
  const radios=Array.from(document.querySelectorAll<HTMLButtonElement>("button[role=radio]"));expect(radios).toHaveLength(2);
  expect(radios[0].textContent).toContain("企业空间");expect(radios[1].textContent).toContain("本地空间");
  expect(document.body.textContent).not.toContain("选择公司本地文件夹");expect(document.body.textContent).not.toContain("使用钉钉登录企业空间");
  await act(async()=>radios[1].click());expect(mock.select).toHaveBeenCalledWith("personal");expect(mock.folder).not.toHaveBeenCalled();expect(mock.login).not.toHaveBeenCalled();
 } finally {await act(async()=>root.unmount());container.remove();}
});

it("opens general settings or signs out from the avatar menu",async()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  const openSettings = vi.fn();
  await act(async()=>root.render(createElement(GlobalAccountMenu, {onOpenSettings:openSettings})));
  const trigger=container.querySelector<HTMLButtonElement>("[data-global-account]")!;
  expect(trigger.getAttribute("aria-label")).toContain("山海测试姓名");
  expect(container.querySelector("img")!.getAttribute("src")).toBe(mock.status.user.avatarUrl);
  expect(container.querySelector("img")!.getAttribute("referrerpolicy")).toBe("no-referrer");
  const openMenu = () => act(async()=> {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
  });
  const items = () => Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]"));
  await openMenu();
  expect(items().map(item=>item.textContent)).toEqual(["设置","退出登录"]);
  await act(async()=>items()[0].click());
  expect(openSettings).toHaveBeenCalledOnce();
  expect(mock.logout).not.toHaveBeenCalled();
  await openMenu();
  await act(async()=>items()[1].click());
  expect(mock.logout).toHaveBeenCalledOnce();
 }finally{await act(async()=>root.unmount());container.remove();}
});

it("shows the account profile, saves the nickname and refreshes authorization in settings",async()=>{
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 try {
  const status: EnterpriseStatus = {
    ...mock.status,
    configured: true,
    serverUrl: "",
    pendingWrites: 0,
    activeSpace: "enterprise",
    accountMode: "shared",
    user: {...mock.status.user, id: "test-user", role: "editor"}
  };
  await act(async()=>root.render(createElement(AccountSettingsPanel,{status})));
  const panel=container.querySelector("[data-account-settings]")!;
  expect(panel.textContent).toContain("山海企业账号：山海测试姓名");
  const input=panel.querySelector<HTMLInputElement>("input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"我的昵称");input.dispatchEvent(new Event("input",{bubbles:true}));});
  const button=(label:string)=>Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent===label)!;
  await act(async()=>button("保存").click());expect(mock.profile).toHaveBeenCalledWith("我的昵称");
  await act(async()=>button("刷新山海账号与授权").click());expect(mock.refresh).toHaveBeenCalledOnce();
  expect(button("退出登录")).toBeUndefined();
 }finally{await act(async()=>root.unmount());container.remove();}
});
