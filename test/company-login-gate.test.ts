// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({status: {configured: true, accountMode: "shared", authenticated: false, imageModels: 0} as Record<string, unknown>, refresh: vi.fn(async () => ({})), resources: vi.fn(async () => ({})), login: vi.fn(async () => ({expiresAt: new Date(Date.now()+60000).toISOString()})), save: vi.fn(), rendererReady: vi.fn(), saveListener: undefined as undefined | ((request: {requestId: string}) => void)}));
vi.mock("../src/components/enterprise/use-enterprise", () => ({useEnterpriseStatus: () => mock.status}));
vi.mock("../src/lib/image-workbench-api", () => ({getImageWorkbenchApi: () => ({refreshCompanyModels: mock.refresh, getPiAgentResources: mock.resources, beginEnterpriseLogin: mock.login, onWindowSaveRequest: (listener: typeof mock.saveListener) => {mock.saveListener=listener;return () => {mock.saveListener=undefined;};}, completeWindowSave: mock.save, windowRendererReady: mock.rendererReady}), getWorkbenchErrorMessage: (value: Error) => value.message}));
import { CompanyLoginGate } from "../src/components/enterprise/CompanyLoginGate";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); mock.status = {configured: true, accountMode: "shared", authenticated: false, imageModels: 0}; });
async function view(test: (container: HTMLDivElement) => Promise<void>) {
  const container = document.createElement("div");document.body.append(container);const root = createRoot(container);
  try { await act(async () => root.render(createElement(CompanyLoginGate, {children: createElement("div", null, "workspace-fixture")})));await test(container); }
  finally { await act(async () => root.unmount());container.remove(); }
}
it("shows DingTalk login before mounting any workspace", async () => {
  await view(async container => {expect(container.textContent).toContain("苏州东轩塑料制品有限公司");expect(container.textContent).not.toContain("workspace-fixture");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "使用钉钉登录")!.click()); expect(mock.login).toHaveBeenCalledOnce();expect(container.textContent).toContain("浏览器");});
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
