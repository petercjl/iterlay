import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoardStore,
  type BoardPersistenceAdapter,
} from "../electron/storage/board-store.js";
import type { BoardLibraryAction } from "../shared/board-library.js";

it("copies folder trees, nested comic boards and internal links with independent identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-library-copy-"));
  try {
    const store = new BoardStore(root),
      board = await store.createBoard("电商项目");
    const comic = await store.createComicDramaProject({
      parentBoardId: board.id,
      name: "品牌故事",
      position: { x: 0, y: 0 },
    });
    const update = async (action: BoardLibraryAction) =>
      store.updateBoardLibrary({
        expectedRevision: (await store.getBoardLibrary()).revision,
        action,
      });
    await update({
      type: "createFolder",
      name: "店铺",
      parentId: null,
      id: "shop",
    });
    await update({
      type: "createFolder",
      name: "主图",
      parentId: "shop",
      id: "images",
    });
    await update({
      type: "move",
      items: [{ kind: "board", id: board.id }],
      parentId: "images",
    });
    const before = await store.getBoard(board.id);
    const state = await update({
      type: "copy",
      items: [
        { kind: "folder", id: "shop" },
        { kind: "board", id: board.id },
      ],
      parentId: null,
    });
    const folder = state.folders.find((f) => f.name === "店铺 副本")!;
    const childFolder = state.folders.find((f) => f.parentId === folder.id)!;
    expect(childFolder.name).toBe("主图");
    const copyId = Object.keys(state.boardFolders).find(
      (id) => id !== board.id,
    )!;
    expect(state.boardFolders[copyId]).toBe(childFolder.id);
    expect(
      (await store.listBoards()).filter((b) => !b.parentBoardId),
    ).toHaveLength(2);
    const copy = (await store.getBoard(copyId))!;
    const entry = copy.nodes.find((n) => n.type === "comic-drama-entry")!;
    expect(entry.type === "comic-drama-entry" && entry.childBoardId).not.toBe(
      comic.childBoard.id,
    );
    if (entry.type === "comic-drama-entry")
      expect((await store.getBoard(entry.childBoardId))?.parentBoardId).toBe(
        copy.id,
      );
    expect(await store.getBoard(board.id)).toEqual(before);
    await expect(
      update({
        type: "copy",
        items: [{ kind: "folder", id: "shop" }],
        parentId: "images",
      }),
    ).rejects.toThrow("自身或其子文件夹");
    expect((await new BoardStore(root).getBoardLibrary()).folders).toHaveLength(
      4,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("recovers a partially committed local paste from its durable journal without duplicating it", async () => {
  const files = new Map<string, unknown>();
  let fail = false;
  const adapter: BoardPersistenceAdapter = {
    read: async (file) => {
      if (!files.has(file))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify(files.get(file));
    },
    write: async (file, value) => {
      if (fail && file.endsWith("library/index.json")) {
        fail = false;
        throw new Error("fixture disk interruption");
      }
      files.set(file, structuredClone(value));
    },
    list: async (directory) =>
      [...files.keys()]
        .filter((f) => f.startsWith(directory + "/"))
        .map((f) => f.slice(directory.length + 1)),
    remove: async (file) => {
      files.delete(file);
    },
  };
  const store = new BoardStore("/fixture", undefined, adapter),
    board = await store.createBoard("图片方案");
  fail = true;
  await expect(
    store.updateBoardLibrary({
      expectedRevision: 0,
      action: {
        type: "copy",
        items: [{ kind: "board", id: board.id }],
        parentId: null,
      },
    }),
  ).rejects.toThrow("disk interruption");
  const restarted = new BoardStore("/fixture", undefined, adapter);
  expect((await restarted.getBoardLibrary()).revision).toBe(1);
  expect((await restarted.listSummaries()).map((b) => b.name).sort()).toEqual([
    "图片方案",
    "图片方案 副本",
  ]);
  expect(files.has("/fixture/boards/.transaction.json")).toBe(false);
});
