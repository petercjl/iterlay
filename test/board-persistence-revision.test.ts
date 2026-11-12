// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useBoardPersistence } from "../src/features/boards/use-board-persistence";
import type { ImageWorkbenchApi } from "../shared/workbench-client";
import type { BoardData } from "../shared/types";
vi.mock("sonner", () => ({ toast: {dismiss: vi.fn(), error: vi.fn()} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("uses the acknowledged unchanged NAS revision on consecutive viewport saves", async () => {
  const board = {id: "board", name: "Board", revision: 7, nodes: [], connections: []} as unknown as BoardData;
  const saveBoard = vi.fn(async () => ({id: "board", name: "Board", revision: 7, imageCount: 0, createdAt: "", updatedAt: ""}));
  const api = {getBoard: vi.fn(async () => board), saveBoard} as unknown as ImageWorkbenchApi;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let persistence: ReturnType<typeof useBoardPersistence>;
  function View() {
    persistence = useBoardPersistence({activeBoard: {current: {id: "board", name: "Board"}}, deletedBoardIds: {current: new Set()}, images: {current: []}, workflowNodes: {current: []}, layout: {current: {positions: {}, connections: [], viewport: {x: 0, y: 0, zoom: 1}}}, thumbnail: {current: {key: "", dataUrl: ""}}, detailCache: {current: {delete: vi.fn()}} as never, getApi: () => api, onSummary: vi.fn(), onSaved: vi.fn()}); return null;
  }
  try {
    await act(async () => root.render(createElement(View)));
    await act(async () => persistence!.persistBoard()); await act(async () => persistence!.persistBoard());
    expect(saveBoard.mock.calls).toHaveLength(2);
    for (const args of saveBoard.mock.calls as unknown as [{expectedRevision: number}][]) expect(args[0].expectedRevision).toBe(7);
    expect(api.getBoard).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
