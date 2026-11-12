import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BoardStore,
  type BoardPersistenceAdapter,
} from "../electron/storage/board-store.js";
import {
  emptyBoardLibrary,
  mutateBoardLibrary,
  type BoardLibraryAction,
} from "../shared/board-library.js";
import { commandStorageScopes } from "../enterprise/src/company-auth.js";

it("persists folders and board locations across restart while keeping contents and trash restoration intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-folders-"));
  try {
    let store = new BoardStore(root);
    const board = await store.createBoard("商品图");
    const original = await store.getBoard(board.id);
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
      name: "新品",
      parentId: "shop",
      id: "products",
    });
    await update({
      type: "move",
      items: [{ kind: "board", id: board.id }],
      parentId: "products",
    });
    await update({ type: "renameFolder", id: "products", name: "主图" });
    expect(await store.getBoard(board.id)).toEqual(original);
    store = new BoardStore(root);
    expect((await store.getBoardLibrary()).boardFolders[board.id]).toBe(
      "products",
    );
    await store.trashBoard(board.id);
    await store.restoreBoard(board.id);
    expect((await store.getBoardLibrary()).boardFolders[board.id]).toBe(
      "products",
    );
    expect(
      await new BoardStore(path.join(root, "other-space")).getBoardLibrary(),
    ).toEqual(emptyBoardLibrary());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects stale concurrent operations and leaves an invalid batch entirely unchanged", async () => {
  const files = new Map<string, unknown>();
  const adapter: BoardPersistenceAdapter = {
    read: async (file) => {
      if (!files.has(file))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return JSON.stringify(files.get(file));
    },
    write: async (file, value) => {
      files.set(file, structuredClone(value));
    },
    list: async (directory) =>
      [...files.keys()]
        .filter((f) => f.startsWith(directory + path.sep))
        .map((f) => f.slice(directory.length + 1)),
    remove: async (file) => {
      files.delete(file);
    },
  };
  const store = new BoardStore("/enterprise", undefined, adapter);
  const board = await store.createBoard("团队画板");
  await store.updateBoardLibrary({
    expectedRevision: 0,
    action: {
      type: "createFolder",
      id: "folder",
      name: "团队",
      parentId: null,
    },
  });
  const stale = new BoardStore("/enterprise", undefined, adapter);
  await expect(
    stale.updateBoardLibrary({
      expectedRevision: 0,
      action: { type: "renameFolder", id: "folder", name: "stale" },
    }),
  ).rejects.toThrow("目录已被更新");
  const before = await store.getBoardLibrary();
  await expect(
    store.updateBoardLibrary({
      expectedRevision: 1,
      action: {
        type: "move",
        parentId: "folder",
        items: [
          { kind: "board", id: board.id },
          { kind: "board", id: "missing" },
        ],
      },
    }),
  ).rejects.toThrow("画板不存在");
  expect(await store.getBoardLibrary()).toEqual(before);
  expect(files.has(path.join("/enterprise", "library", "index.json"))).toBe(true);
});

it("guards duplicate names, Windows-invalid names, cycles and non-empty deletion", () => {
  let state = emptyBoardLibrary();
  const ids = new Set(["board"]);
  const apply = (action: BoardLibraryAction) => {
    state = mutateBoardLibrary(
      state,
      { expectedRevision: state.revision, action },
      ids,
      "auto",
    );
  };
  apply({ type: "createFolder", id: "parent", name: "Parent", parentId: null });
  apply({
    type: "createFolder",
    id: "child",
    name: "Child",
    parentId: "parent",
  });
  for (const name of ["CON", "bad/name", "bad\\name", "..", "x.", "", "parent"])
    expect(() =>
      apply({ type: "createFolder", name, parentId: null }),
    ).toThrow();
  expect(() =>
    apply({
      type: "move",
      items: [{ kind: "folder", id: "parent" }],
      parentId: "child",
    }),
  ).toThrow("自身或其子文件夹");
  expect(() => apply({ type: "deleteEmptyFolder", id: "parent" })).toThrow(
    "请先移出",
  );
  apply({
    type: "move",
    parentId: "child",
    items: [{ kind: "board", id: "board" }],
  });
  expect(() => apply({ type: "deleteEmptyFolder", id: "child" })).toThrow(
    "请先移出",
  );
  apply({
    type: "move",
    parentId: null,
    items: [
      { kind: "folder", id: "parent" },
      { kind: "folder", id: "child" },
      { kind: "board", id: "board" },
    ],
  });
  expect(state.folders.find((f) => f.id === "child")?.parentId).toBe("parent");
  expect(state.boardFolders.board).toBe("child");
});

it("allows viewer folder reads while requiring a write grant for mutations", () => {
  expect(commandStorageScopes("boards:library:get")).toEqual(["boards:read"]);
  expect(commandStorageScopes("boards:library:update")).toEqual([
    "boards:read",
    "boards:write",
  ]);
});
