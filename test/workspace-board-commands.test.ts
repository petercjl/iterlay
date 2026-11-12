import { describe, expect, it } from "vitest";
import { workspaceFixture } from "./helpers/workspace-fixture";
describe("typed workspace board commands", () => {
  it("flushes before mutation and emits the resulting update", async () => {
    const f = workspaceFixture();
    f.flush.mockImplementation(async () => { expect(f.mocks.moveBoardImage).not.toHaveBeenCalled(); });
    await f.commands.call("move_image", { boardId: "board", nodeId: "image", x: 10, y: 20 });
    expect(f.flush).toHaveBeenCalledOnce();
    expect(f.mocks.moveBoardImage).toHaveBeenCalledWith("board", "image", 10, 20);
    expect(f.emit).toHaveBeenCalledWith({ type: "board-updated", boardId: "board", movedNodeId: "image", x: 10, y: 20 });
  });
  it("marks passive creation events so the active chat is not navigated away", async () => {
    const f = workspaceFixture();
    f.mocks.createBoard.mockResolvedValue({ id: "created", name: "创作" });
    await f.commands.call("create_board", { name: "创作", preserveView: true });
    expect(f.emit).toHaveBeenCalledWith({ type: "board-created", boardId: "created", name: "创作", preserveView: true });
    await f.commands.call("move_image", { boardId: "board", nodeId: "image", x: 10, y: 20, preserveView: true });
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "board-updated", preserveView: true }));
  });
  it("does not mutate when saving fails", async () => {
    const f = workspaceFixture();
    f.flush.mockRejectedValue(new Error("disk full"));
    await expect(f.commands.call("move_image", { boardId: "board", nodeId: "image", x: 10, y: 20 })).rejects.toThrow("disk full");
    expect(f.mocks.moveBoardImage).not.toHaveBeenCalled();
  });
  it("validates nodes before focusing the UI", async () => {
    const f = workspaceFixture();
    await expect(f.commands.call("focus_nodes", { boardId: "board", nodeIds: ["missing"] })).rejects.toThrow("不存在");
    expect(f.emit).not.toHaveBeenCalled();
    await f.commands.call("focus_nodes", { boardId: "board", nodeIds: ["image", "image"] });
    expect(f.emit).toHaveBeenCalledWith({ type: "focus-nodes", boardId: "board", nodeIds: ["image"] });
  });
  it("rejects invalid coordinates and unknown tools", async () => {
    const f = workspaceFixture();
    await expect(f.commands.call("move_image", { boardId: "board", nodeId: "image", x: Infinity, y: 1 })).rejects.toThrow("有限数字");
    await expect(f.commands.call("__proto__", {})).rejects.toThrow("未知");
    expect(f.mocks.moveBoardImage).not.toHaveBeenCalled();
  });
  it("reads active board through application services without evaluating JavaScript", async () => {
    const f = workspaceFixture();
    await f.commands.call("get_active_board", {});
    expect(f.mocks.getBoard).toHaveBeenCalledWith("board");
  });
  it("uses dedicated trash/restore events so the UI stops saving a removed board", async () => {
    const f = workspaceFixture();
    f.mocks.deleteBoard.mockResolvedValue({ ok: true });
    await f.commands.call("trash_board", { boardId: "board" });
    expect(f.emit).toHaveBeenCalledWith({ type: "board-trashed", boardId: "board" });
    expect(f.emit).not.toHaveBeenCalledWith({ type: "board-updated", boardId: "board" });
    f.emit.mockClear();
    await f.commands.call("restore_board", { boardId: "board" });
    expect(f.emit).toHaveBeenCalledWith({ type: "board-restored", boardId: "board" });
  });
  it("requests authoritative canvas layout hydration for plugin writes", async () => {
    const f = workspaceFixture();
    await f.commands.call("write_board_text", { boardId: "board", operationId: "note", text: "说明" });
    expect(f.emit).toHaveBeenCalledWith({ type: "board-updated", boardId: "board", reloadLayout: true });
  });
});

describe("board tool read payloads", () => {
  it.each(["get_board", "get_active_board"])("%s preserves every semantic field without cover bytes", async (method) => {
    const f = workspaceFixture();
    const board = {
      id: "board", revision: 42, name: "带封面的画板",
      thumbnailDataUrl: "data:image/png;base64," + "A".repeat(500_000),
      enterpriseState: Buffer.from("thumbnailDataUrl:" + "A".repeat(500_000)).toString("base64"),
      enterpriseEpoch: "epoch",
      nodes: [
        { id: "image", imagePath: "/managed/source.png", x: 0, y: 0, versions: [{ imagePath: "/managed/old.png" }] },
        { id: "text", type: "text", text: "完整文字".repeat(1000), x: 100, y: 20 },
        { id: "canvas", type: "canvas", code: "<p>保留完整代码</p>", x: 200, y: 20 }
      ],
      images: { "/managed/source.png": "tuda-asset://source" },
      connections: [{ id: "connection", source: "image", target: "text" }],
      groups: [{ id: "group", nodeIds: ["image", "text"] }]
    };
    f.mocks.getBoard.mockResolvedValue(board);
    const result = await f.commands.call(method, { boardId: "board" });
    const { thumbnailDataUrl, enterpriseState, ...expected } = board;
    expect(result).toEqual(expected);
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
    expect(board.thumbnailDataUrl).toBe(thumbnailDataUrl);
    expect(board.enterpriseState).toBe(enterpriseState);
    expect(result).not.toBe(board);
    expect(f.flush).not.toHaveBeenCalled();
  });
  it("omits cover bytes from board lists without changing stored summaries", async () => {
    const f = workspaceFixture();
    const summaries = [{ id: "board", name: "测试", imageCount: 2, thumbnailDataUrl: "data:image/png;base64,AA==" }];
    f.mocks.listBoards.mockResolvedValue(summaries);
    expect(await f.commands.call("list_boards", {})).toEqual([{ id: "board", name: "测试", imageCount: 2 }]);
    expect(summaries[0].thumbnailDataUrl).toBeDefined();
  });
  it("preserves missing board and empty active-board semantics", async () => {
    const f = workspaceFixture();
    f.mocks.getBoard.mockResolvedValue(null);
    expect(await f.commands.call("get_board", { boardId: "missing" })).toBeNull();
    f.mocks.getBoardsState.mockResolvedValue({ lastOpenedBoardId: null });
    expect(await f.commands.call("get_active_board", {})).toBeNull();
  });
});
