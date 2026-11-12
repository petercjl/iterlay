// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSkillBoard } from "../src/components/workbench/AgentSkillBoard";
import type { AgentSkillLibrary, PiAgentResourceInventory } from "../shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; container?.remove(); });
const inventory: PiAgentResourceInventory = { builtinTools: [], tudaTools: [], extensions: [], warnings: [], skills: [
  { id: "photo", kind: "skill", name: "产品摄影", description: "场景光线", path: "/photo/SKILL.md", source: "custom", skillCategory: "user" },
  { id: "video", kind: "skill", name: "视频分镜", description: "视频脚本", path: "/video/SKILL.md", source: "custom", skillCategory: "user" },
  { id: "base", kind: "skill", name: "系统指南", description: "内置指南", path: "/base/SKILL.md", source: "system", skillCategory: "system" }
] };
const library: AgentSkillLibrary = { version: 1, folders: [{ id: "commerce", name: "电商", parentId: null }], assignments: { "/photo/SKILL.md": "commerce" }, favorites: ["/photo/SKILL.md"] };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;
async function render() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const onUse = vi.fn(), onMutation = vi.fn(async () => library);
  await act(async () => root!.render(createElement(AgentSkillBoard, { inventory, library, loading: false, error: "", onRefresh: vi.fn(async () => {}), onMutation, onUse, onDelete: vi.fn(async () => {}), onClose: vi.fn() })));
  return { onUse, onMutation };
}
it("provides favorite, folder and system views and returns the chosen Skill", async () => {
  const { onUse } = await render();
  expect(container.querySelectorAll("article")).toHaveLength(2);
  await act(async () => button("收藏1").click());
  expect(container.querySelectorAll("article")).toHaveLength(1);
  expect(container.querySelector("article")?.textContent).toContain("产品摄影");
  await act(async () => button("使用").click());
  expect(onUse).toHaveBeenCalledWith("/photo/SKILL.md");
  await act(async () => button("电商").click());
  expect(container.querySelectorAll("article")).toHaveLength(1);
  await act(async () => button("系统 Skill1").click());
  expect(container.querySelector("article")?.textContent).toContain("系统指南");
  expect(container.textContent).not.toContain("用户 Skill 保存在本机");
});
it("searches within the current view and updates favorites through the persistent contract", async () => {
  const { onMutation } = await render();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索 Skill"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "视频");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll("article")).toHaveLength(1);
  await act(async () => button("收藏 Skill 视频分镜").click());
  expect(onMutation).toHaveBeenCalledWith({ type: "setFavorite", skillPath: "/video/SKILL.md", favorite: true });
});

it("assigns a user Skill to a folder through the library contract", async () => {
  const { onMutation } = await render();
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="分类文件夹 视频分镜"]')!;
  await act(async () => { select.value = "commerce"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onMutation).toHaveBeenCalledWith({ type: "setFolder", skillPath: "/video/SKILL.md", folderId: "commerce" });
});
