// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({status: {configured: true, accountMode: "shared", authenticated: false, imageModels: 0} as Record<string, unknown>, refresh: vi.fn(async () => ({})), resources: vi.fn(async () => ({})), login: vi.fn(async (): Promise<{expiresAt: string; userCode?: string}> => ({expiresAt: new Date(Date.now()+60000).toISOString()})), poll: vi.fn(), cancel: vi.fn(async () => true), save: vi.fn(), rendererReady: vi.fn(), saveListener: undefined as undefined | ((request: {requestId: string}) => void)}));
vi.mock("../src/components/enterprise/use-enterprise", () => ({useEnterpriseStatus: () => mock.status}));
vi.mock("../src/lib/image-workbench-api", () => ({getImageWorkbenchApi: () => ({refreshCompanyModels: mock.refresh, getPiAgentResources: mock.resources, beginEnterpriseLogin: mock.login, pollEnterpriseLogin: mock.poll, cancelEnterpriseLogin: mock.cancel, onWindowSaveRequest: (listener: typeof mock.saveListener) => {mock.saveListener=listener;return () => {mock.saveListener=undefined;};}, completeWindowSave: mock.save, windowRendererReady: mock.rendererReady}), getWorkbenchErrorMessage: (value: Error) => value.message}));
import { CompanyLoginGate } from "../src/components/enterprise/CompanyLoginGate";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); mock.status = {configured: true, accountMode: "shared", authenticated: false, imageModels: 0}; });
async function view(test: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container);
  try { await act(async () => root.render(createElement(CompanyLoginGate, {children: createElement("div", null, "workspace-fixture")})));await test(container); }
  finally { await act(async () => root.unmount());container.remove(); }
}
it("shows both brands and disables employee login without a Shanhai deployment", async () => {
  await view(async container => {
    expect(container.querySelector("h1")?.textContent).toContain("Tuda · 图塔 × 山海 OMNI");
    expect(container.textContent).toContain("在山海 OMNI 中确认授权，即可登录 Tuda。");
    expect(container.textContent).not.toContain("workspace-fixture");
    expect(container.textContent).not.toContain("钉钉");
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(mock.login).not.toHaveBeenCalled();
  });
});
it("opens Omni authorization and shows the verification code with one sign-in action", async () => {
  mock.status.accountProvider = "omni";
  mock.login.mockResolvedValueOnce({ expiresAt: new Date(Date.now() + 60_000).toISOString(), userCode: "FIXTURE1" });
  await view(async container => {
    expect(container.textContent).not.toContain("钉钉");
    expect(container.textContent).not.toContain("访客登录");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("form")).toBeNull();
    const button = [...container.querySelectorAll("button")].find(item => item.textContent === "前往山海授权登录")!;
    await act(async () => button.click());
    expect(mock.login).toHaveBeenCalledWith();
    expect(container.textContent).toContain("FIXTURE1");
  });
});
it("cancels while polling and keeps a fresh request visible after the old poll fails", async () => {
  vi.useFakeTimers();
  mock.status.accountProvider = "omni";
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  mock.login.mockResolvedValueOnce({ expiresAt, userCode: "OLD00001" })
    .mockResolvedValueOnce({ expiresAt, userCode: "NEW00002" });
  let failOld!: (error: Error) => void;
  mock.poll.mockImplementationOnce(() => new Promise((_, reject) => { failOld = reject; }));
  try {
    await view(async container => {
      const click = async (name: string) => await act(async () => {
        [...container.querySelectorAll("button")].find(item => item.textContent === name)!.click();
      });
      await click("前往山海授权登录");
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(mock.poll).toHaveBeenCalledOnce();
      await click("取消授权");
      expect(mock.cancel).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain("OLD00001");
      await click("前往山海授权登录");
      await act(async () => { failOld(new Error("旧轮询失败")); });
      expect(container.textContent).toContain("NEW00002");
      expect(container.textContent).not.toContain("旧轮询失败");
    });
  } finally {
    vi.useRealTimers();
  }
});
it("acknowledges close requests while the login page owns the window", async () => {
 await view(async () => {
  expect(mock.rendererReady).toHaveBeenCalled();
  mock.saveListener?.({requestId:"close-login"});
  expect(mock.save).toHaveBeenCalledWith({requestId:"close-login",ok:true});
 });
 expect(mock.saveListener).toBeUndefined();
});
it("lets a logged-in employee without image key enter after model/tool preparation", async () => {
  mock.status.authenticated = true;
  await view(async container => {expect(container.textContent).toContain("workspace-fixture"); expect(mock.refresh).toHaveBeenCalledOnce(); expect(mock.resources).toHaveBeenCalledOnce();});
});
it("keeps workspace hidden when company verification fails", async () => {
  mock.status.authenticated = true; mock.refresh.mockRejectedValueOnce(new Error("组织授权失败"));
  await view(async container => {expect(container.textContent).not.toContain("workspace-fixture");expect(container.textContent).toContain("组织授权失败");});
});
it("does not accept a legacy or unconfigured account as company login", async () => {
  mock.status = {configured: true, authenticated: true};
  await view(async container => {expect(container.textContent).not.toContain("workspace-fixture");expect(container.textContent).toContain("联系管理员");});
});
