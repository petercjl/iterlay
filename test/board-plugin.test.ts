import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { boardPluginTools, assertBoardPluginMethod } from "../electron/board-plugin-tools.js";
import { executeBoardPluginWrite } from "../electron/application/board-plugin.js";
import { BoardStore } from "../electron/storage/board-store.js";
import type { WorkspaceApi } from "../electron/application/workbench-api.js";
import { WorkspaceCommands } from "../electron/application/workspace-commands.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=";
it("only exposes board organization and denies generation, agents, configuration and generic dispatch", () => {
  const names = boardPluginTools().map(t => t.name);
  expect(names).toContain("create_board");
  expect(names).toContain("write_board_text");
  for (const name of ["generate_image", "edit_image", "generate_video", "configure_provider", "create_canvas", "call", "__proto__"]) {
    expect(names).not.toContain(name);
    expect(() => assertBoardPluginMethod(name)).toThrow("PLUGIN_CAPABILITY_DENIED");
  }
});
it("persists a batch and editable note, reuses operation IDs after restart, protects concurrent and locked edits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tuda-plugin-"));
  try {
    let store = new BoardStore(dir);
    const board = await store.createBoard("插件验收");
    await store.appendNodes(board.id, [{ id: "existing", source: "upload", imagePath: "/managed/original.png", jobId: "original", displayWidth: 500, width: 100, height: 200 }]);
    const importImage = vi.fn(async () => ({ path: "/managed/import.png" }));
    const api = { getBoard: (id: string) => store.getBoard(id), saveBoard: (payload: Parameters<BoardStore["saveBoard"]>[0]) => store.saveBoard(payload), importUploadedImage: importImage } as unknown as WorkspaceApi;
    const input = { boardId: board.id, operationId: "batch-1", images: [png, png, png], columns: 2 };
    const first = await executeBoardPluginWrite(api, "import_board_images", input) as { nodeIds: string[] };
    expect(first.nodeIds).toHaveLength(3);
    let saved = (await store.getBoard(board.id))!;
    expect(saved.nodes[0].x).toBe(0);
    expect(saved.nodes[1]).toMatchObject({ x: 540, y: 0, width: 1, height: 1 });
    expect(saved.nodes[3]).toMatchObject({ x: 540, y: 340 });
    store = new BoardStore(dir);
    expect(await executeBoardPluginWrite(api, "import_board_images", input)).toMatchObject({ reused: true, nodeIds: first.nodeIds });
    expect(importImage).toHaveBeenCalledTimes(3);
    await expect(executeBoardPluginWrite(api, "import_board_images", { ...input, columns: 3 })).rejects.toThrow("OPERATION_ID_CONFLICT");
    const note = await executeBoardPluginWrite(api, "write_board_text", { boardId: board.id, operationId: "note", text: "设计说明", anchorNodeId: first.nodeIds[0], side: "below" }) as { nodeIds: string[] };
    saved = (await store.getBoard(board.id))!;
    expect(saved.nodes.find(n => n.id === note.nodeIds[0])).toMatchObject({ type: "text", text: "设计说明", x: 540, y: 680 });
    await expect(executeBoardPluginWrite(api, "write_board_text", { boardId: board.id, operationId: "update", nodeId: note.nodeIds[0], text: "覆盖", expectedText: "旧文字" })).rejects.toThrow("TEXT_CONFLICT");
    await expect(executeBoardPluginWrite(api, "move_board_nodes", { boardId: board.id, expectedRevision: 0, positions: [{ nodeId: note.nodeIds[0], x: 10, y: 20 }] })).rejects.toThrow("REVISION_CONFLICT");
    await executeBoardPluginWrite(api, "move_board_nodes", { boardId: board.id, expectedRevision: saved.revision, positions: [{ nodeId: note.nodeIds[0], x: 10, y: 20 }] });
    saved = (await store.getBoard(board.id))!;
    await store.saveBoard({ id: board.id, nodes: saved.nodes.map(n => n.id === note.nodeIds[0] ? { ...n, locked: true } : n) });
    await expect(executeBoardPluginWrite(api, "write_board_text", { boardId: board.id, operationId: "locked", nodeId: note.nodeIds[0], text: "覆盖", expectedText: "设计说明" })).rejects.toThrow("NODE_LOCKED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("validates an entire image batch before importing and preserves the board on stale save", async () => {
  const importUploadedImage = vi.fn();
  const saveBoard = vi.fn(async () => { throw new Error("BOARD_REVISION_CONFLICT"); });
  const api = { getBoard: async () => ({ id: "b", nodes: [], revision: 3 }), saveBoard, importUploadedImage } as unknown as WorkspaceApi;
  await expect(executeBoardPluginWrite(api, "import_board_images", { boardId: "b", operationId: "op", images: [png, "invalid"] })).rejects.toThrow();
  expect(importUploadedImage).not.toHaveBeenCalled();
  await expect(executeBoardPluginWrite(api, "write_board_text", { boardId: "b", operationId: "op", text: "注释" })).rejects.toThrow("REVISION_CONFLICT");
  expect(saveBoard).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3 }));
});
it("keeps durable idempotency after the UI rewrites node metadata and a plugin restarts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tuda-plugin-receipt-"));
  try {
    const store = new BoardStore(dir);
    const board = await store.createBoard("持久回执");
    const api = { getBoard: (id: string) => store.getBoard(id), saveBoard: (payload: Parameters<BoardStore["saveBoard"]>[0]) => store.saveBoard(payload) } as unknown as WorkspaceApi;
    const dependencies = { api, taskDirectory: path.join(dir, "receipts"), flush: async () => undefined, emit: () => undefined };
    const input = { boardId: board.id, operationId: "note-1", text: "原始说明" };
    const result = await new WorkspaceCommands(dependencies).call("write_board_text", input) as { nodeIds: string[] };
    await store.saveBoard({ id: board.id, nodes: [{ id: result.nodeIds[0], type: "text", text: "用户修改", x: 12, y: 24 }] });
    expect(await new WorkspaceCommands(dependencies).call("write_board_text", { text: input.text, operationId: input.operationId, boardId: input.boardId })).toMatchObject({ reused: true });
    const saved = (await store.getBoard(board.id))!;
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]).toMatchObject({ text: "用户修改", x: 12 });
    await expect(new WorkspaceCommands(dependencies).call("write_board_text", { ...input, text: "异参" })).rejects.toThrow("OPERATION_ID_CONFLICT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
