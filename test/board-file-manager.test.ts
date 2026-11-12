// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  emptyBoardLibrary,
  mutateBoardLibrary,
  type BoardLibraryMutation,
} from "../shared/board-library.js";
const data = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock("../src/lib/image-workbench-api", () => ({
  getImageWorkbenchApi: () => data.api,
  getWorkbenchErrorMessage: (e: Error) => e.message,
}));
vi.mock("../src/components/enterprise/use-enterprise", () => ({
  useEnterpriseStatus: () => undefined,
}));
import { BoardFileManager } from "../src/components/workbench/BoardFileManager";
import { I18nProvider } from "../src/i18n";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("navigates nested folders, scopes new boards, selects without opening, and moves using the file-manager UI", async () => {
  window.localStorage.setItem("tuda:language", "zh-CN");
  let state = mutateBoardLibrary(
    emptyBoardLibrary(),
    {
      expectedRevision: 0,
      action: {
        type: "createFolder",
        name: "电商项目",
        id: "commerce",
        parentId: null,
      },
    },
    new Set(["board"]),
    "commerce",
  );
  const update = vi.fn(async (input: BoardLibraryMutation) => {
    state = mutateBoardLibrary(state, input, new Set(["board"]), "new");
    return structuredClone(state);
  });
  data.api = {
    getBoardLibrary: vi.fn(async () => structuredClone(state)),
    updateBoardLibrary: update,
    onWorkbenchEvent: () => () => undefined,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    open = vi.fn(),
    create = vi.fn();
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    )!;
  try {
    await act(async () =>
      root.render(
        createElement(
          I18nProvider,
          null,
          createElement(BoardFileManager, {
            boards: [
              {
                id: "board",
                name: "画板文件",
                imageCount: 0,
                createdAt: "2026-11-12T00:00:00Z",
                updatedAt: "2026-11-12T00:00:00Z",
              },
            ],
            onOpenBoard: open,
            onCreateBoard: create,
            onPrefetchBoard: vi.fn(),
            onRenameBoard: vi.fn(),
            onDuplicateBoard: vi.fn(),
            onDeleteBoard: vi.fn(async () => undefined),
            onExportBoard: vi.fn(),
            onImportBoard: vi.fn(async () => undefined),
            onImportBoardFiles: vi.fn(async () => undefined),
            onClose: vi.fn(),
          }),
        ),
      ),
    );
    const board = container.querySelector<HTMLButtonElement>(
      '[aria-label="打开画板 画板文件"]',
    )!;
    await act(async () => board.click());
    expect(open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("已选择 1 项");
    await act(async () => button("剪切").click());
    const folder = container.querySelector<HTMLButtonElement>(
      '[aria-label="打开文件夹 电商项目"]',
    )!;
    await act(async () =>
      folder.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    await act(async () => button("新建画板").click());
    expect(create).toHaveBeenCalledWith("commerce");
    await act(async () => button("粘贴 1 项").click());
    expect(state.boardFolders.board).toBe("commerce");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        action: {
          type: "move",
          items: [{ kind: "board", id: "board" }],
          parentId: "commerce",
        },
      }),
    );
    const moved = container.querySelector<HTMLButtonElement>(
      '[aria-label="打开画板 画板文件"]',
    )!;
    await act(async () =>
      moved.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    expect(open).toHaveBeenCalledWith("board", expect.anything());
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("tuda:language");
  }
});
