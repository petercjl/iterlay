// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsRow } from "../src/components/workbench/settings/SettingsPrimitives";
import { ChoiceGrid } from "../src/components/workbench/settings/provider-settings-components";
import { ModelRoutingSettings } from "../src/components/workbench/settings/ModelRoutingSettings";
import { COMMUNITY_TEXT_PROVIDER } from "../shared/community-providers";
import { Switch } from "../src/components/ui/switch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
async function mount(element: React.ReactElement) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  disposers.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return host;
}

describe("shared settings controls", () => {
  it("shows personal channel editing and keeps managed connection details out of the model panel", async () => {
    const personal = { ...COMMUNITY_TEXT_PROVIDER, id: "personal", name: "Local relay", model: "personal-upstream", baseUrl: "https://local.example/v1" };
    const company = { ...personal, id: "company-text/tenant/model", model: "enterprise-upstream", name: "private-channel", baseUrl: "https://private.example/v1" };
    const revealLocalModelChannelKey = vi.fn(async () => "fixture-personal-key");
    const saveModelRouting = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("imageWorkbench", { revealLocalModelChannelKey, saveModelRouting, getSettings: async () => ({ textProviders: [personal, company],
      activeTextProviderId: personal.id, providerKeyStatus: { personal: true, [company.id]: true } }) });
    disposers.push(async () => { vi.unstubAllGlobals(); });
    const host = await mount(createElement(ModelRoutingSettings, { providers: [], activeProviderId: "" }));
    const open = async (name: string) => act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent?.includes(name))!.click());
    await open("enterprise-upstream");
    expect(host.textContent).toContain("山海管理");
    expect(host.textContent).not.toMatch(/private-channel|添加渠道|移除模型/u);
    expect(host.querySelector('button[aria-label="编辑渠道"]')).toBeNull();
    expect(host.querySelector('button[aria-label="显示 API Key"]')).toBeNull();
    await open("personal-upstream");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="编辑渠道"]')!.click());
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(personal.baseUrl);
    const key = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(key.placeholder).toBe("••••••••••••");
    expect(key.value).toBe("");
    expect(revealLocalModelChannelKey).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="显示 API Key"]')!.click());
    expect(key.type).toBe("text");
    expect(key.value).toBe("fixture-personal-key");
    expect(revealLocalModelChannelKey).toHaveBeenCalledWith("text", personal.id);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="隐藏 API Key"]')!.click());
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    expect(host.querySelector('[aria-label="选择服务和模型"]')).toBeNull();
    await open("保存渠道");
    await open("保存模型设置");
    const saved = saveModelRouting.mock.calls[0] as unknown as [{ channels: Array<Record<string, unknown>> }];
    expect(saved[0].channels[0]).toMatchObject({ sourceProviderId: personal.id, model: personal.model });
    expect(saved[0].channels[0]).not.toHaveProperty("apiKey");
  });

  it("lets a fresh user add a locally configured channel directly under a named text model", async () => {
    const saveModelRouting = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("imageWorkbench", { saveModelRouting, getSettings: async () => ({
      textProviders: [COMMUNITY_TEXT_PROVIDER], activeTextProviderId: COMMUNITY_TEXT_PROVIDER.id, providerKeyStatus: {}
    }) });
    disposers.push(async () => { vi.unstubAllGlobals(); });
    const host = await mount(createElement(ModelRoutingSettings, { providers: [], activeProviderId: "" }));
    const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
      .find(item => item.textContent?.trim() === label)!;
    const change = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => button("添加模型").click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("模型名称由你自定");
    expect(dialog.textContent).toContain("请在该模型中添加 API 渠道");
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    await act(async () => change(dialog.querySelector("input")!, "东轩 · 文本"));
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
    await act(async () => button("添加渠道").click());
    const channelForm = Array.from(host.querySelectorAll("form")).find(form => form.textContent?.includes("新建 API 渠道"))!;
    const fields = channelForm.querySelectorAll("input");
    expect(fields[3].type).toBe("password");
    await act(async () => ["任意服务", "https://relay.example/v1", "vendor-model", "fixture-key"].forEach((value, index) => change(fields[index], value)));
    await act(async () => channelForm.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(host.textContent).toContain("任意服务 · vendor-model");
    expect(host.textContent).not.toContain("fixture-key");
    await act(async () => button("保存模型设置").click());
    expect(saveModelRouting).toHaveBeenCalledWith({
      channels: [expect.objectContaining({ name: "任意服务", baseUrl: "https://relay.example/v1", model: "vendor-model", apiKey: "fixture-key" })],
      otherModelRouting: { text: { defaultModel: "东轩 · 文本", models: [{ name: "东轩 · 文本",
        channels: [{ providerId: expect.stringMatching(/^local-channel-/), model: "vendor-model" }] }] } }
    });
  });
  it("offers the default-model selector and the same creation dialog on every model type", async () => {
    vi.stubGlobal("imageWorkbench", { getSettings: async () => ({ providerKeyStatus: {}, textProviders: [], videoProviders: [], audioProviders: [] }) });
    disposers.push(async () => { vi.unstubAllGlobals(); });
    const host = await mount(createElement(ModelRoutingSettings, { providers: [], activeProviderId: "" }));
    for (const name of ["文本模型", "图片模型", "视频模型", "音频模型"]) {
      const tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(button => button.textContent === name)!;
      await act(async () => tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
      expect(tab.getAttribute("aria-selected")).toBe("true");
      expect(host.textContent).toContain("默认模型");
      expect(host.querySelector("select")).not.toBeNull();
      const add = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "添加模型")!;
      await act(async () => add.click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.querySelectorAll("input")).toHaveLength(1);
      const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "取消")!;
      await act(async () => cancel.click());
    }
  });
  it("keeps the whole labeled setting row usable as a switch target", async () => {
    const change = vi.fn();
    const host = await mount(createElement(SettingsRow, {
      title: "显示创作助手", description: "显示入口与快捷键", interactive: true,
      control: createElement(Switch, { checked: false, onCheckedChange: change })
    }));
    await act(async () => host.querySelector<HTMLSpanElement>(".settings-row-description")!.click());
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith(true);
  });

  it("moves selection and focus together when using arrow keys in a radio group", async () => {
    function Fixture() {
      const [value, setValue] = useState("balanced");
      return createElement(ChoiceGrid, { value, onChange: setValue, ariaLabel: "使用程度", columns: 3,
        options: [{ value: "cautious", title: "谨慎" }, { value: "balanced", title: "平衡" }, { value: "active", title: "积极" }] });
    }
    const host = await mount(createElement(Fixture));
    const radios = host.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[1].focus();
    await act(async () => radios[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[2]);
    expect(radios[1].tabIndex).toBe(-1);
    await act(async () => radios[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("keeps disabled options inactive when their parent setting is unavailable", async () => {
    const change = vi.fn();
    const host = await mount(createElement(ChoiceGrid, { value: "png", onChange: change, ariaLabel: "复制格式", disabled: true,
      options: [{ value: "png", title: "PNG" }, { value: "gif", title: "GIF" }] }));
    await act(async () => host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click());
    expect(change).not.toHaveBeenCalled();
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-disabled")).toBe("true");
  });
});
