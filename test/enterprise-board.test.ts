import { BoardSaveCausality } from "../shared/enterprise-causality.js";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { createBoardDocument, encodeBoardChange, readBoardDocument } from "../shared/enterprise-board.js";
import type { BoardData } from "../shared/types.js";
import { BoardStore, type BoardPersistenceAdapter } from "../electron/storage/board-store.js";

const fixture = (): BoardData => ({ id: "test-board", name: "协同", schemaVersion: 3, revision: 0, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z", nodes: [
  { id: "a", type: "text", text: "你好", x: 10, y: 20 }, { id: "b", type: "text", text: "商品", x: 300, y: 20 }
] });

it("merges independent authors without replacing their peer's node or geometry", () => {
  const initial = createBoardDocument(fixture()), state = Y.encodeStateAsUpdate(initial);
  const a = fixture(), b = fixture(); a.nodes[0] = { ...a.nodes[0], x: 80, y: 90 }; b.nodes[1] = { ...b.nodes[1], title: "参考" };
  const deltaA = encodeBoardChange(state, a), deltaB = encodeBoardChange(state, b);
  for (const order of [[deltaA, deltaB], [deltaB, deltaA]]) {
    const server = new Y.Doc(); Y.applyUpdate(server, state); for (const delta of order) Y.applyUpdate(server, delta);
    const result = readBoardDocument(server, 2, fixture().updatedAt);
    expect(result.nodes.find(node => node.id === "a")).toMatchObject({ x: 80, y: 90 });
    expect(result.nodes.find(node => node.id === "b")).toMatchObject({ title: "参考" });
    Y.applyUpdate(server, deltaA); expect(readBoardDocument(server, 2, fixture().updatedAt)).toEqual(result);
    server.destroy();
  }
  initial.destroy();
});

it("combines concurrent text edits and does not resurrect a remotely deleted node", () => {
  const initial = createBoardDocument(fixture()), state = Y.encodeStateAsUpdate(initial);
  const a = fixture(), b = fixture();
  a.nodes[0] = { ...a.nodes[0], text: "你好世界" } as never;
  b.nodes[0] = { ...b.nodes[0], text: "大家你好" } as never;
  const server = new Y.Doc(); Y.applyUpdate(server, state); Y.applyUpdate(server, encodeBoardChange(state, a)); Y.applyUpdate(server, encodeBoardChange(state, b));
  expect((readBoardDocument(server, 1, fixture().updatedAt).nodes[0] as { text: string }).text).toBe("大家你好世界");
  const deletion = fixture(); deletion.nodes = deletion.nodes.filter(node => node.id !== "a");
  Y.applyUpdate(server, encodeBoardChange(state, deletion));
  Y.applyUpdate(server, encodeBoardChange(state, a));
  expect(readBoardDocument(server, 2, fixture().updatedAt).nodes.some(node => node.id === "a")).toBe(false);
  server.destroy(); initial.destroy();
});

it("selectively undoes the local author's change while retaining peer edits", () => {
  const initial = createBoardDocument(fixture()), state = Y.encodeStateAsUpdate(initial), client = new Y.Doc(); Y.applyUpdate(client, state);
  const history = new Y.UndoManager(client.getMap("nodes"), { trackedOrigins: new Set(["local"]) });
  const a = fixture(); a.nodes[0].x = 100;
  Y.applyUpdate(client, encodeBoardChange(state, a), "local");
  const b = fixture(); b.nodes[1].y = 500;
  Y.applyUpdate(client, encodeBoardChange(state, b), "peer");
  history.undo();
  const result = readBoardDocument(client, 3, fixture().updatedAt);
  expect(result.nodes.find(node => node.id === "a")?.x).toBe(10);
  expect(result.nodes.find(node => node.id === "b")?.y).toBe(500);
  history.destroy(); client.destroy(); initial.destroy();
});

it("runs existing board business operations through an independent persistence adapter", async () => {
  const files = new Map<string, unknown>();
  const adapter: BoardPersistenceAdapter = {
    read: async file => { if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return JSON.stringify(files.get(file)); },
    write: async (file, value) => { files.set(file, structuredClone(value)); },
    list: async directory => [...files.keys()].filter(file => file.startsWith(directory + "/")).map(file => file.slice(directory.length + 1)),
    remove: async file => { files.delete(file); }
  };
  const store = new BoardStore("/virtual-enterprise", undefined, adapter);
  const board = await store.createBoard("企业画板");
  await store.saveBoard({ ...board, nodes: fixture().nodes });
  expect((await store.listSummaries())[0].name).toBe("企业画板");
  expect(await store.trashBoard(board.id)).toBe(true);
  expect(await store.getBoard(board.id)).toBeNull();
  expect((await store.restoreBoard(board.id))?.nodes).toHaveLength(2);
  expect((await store.duplicateBoard(board.id))?.id).not.toBe(board.id);
});

it("preserves the latest sequential offline edit from a stale observed revision in either delivery order", () => {
  for (let attempt = 0; attempt < 32; attempt++) {
    const initial = createBoardDocument(fixture()), state = Y.encodeStateAsUpdate(initial);
    const first = fixture(); first.nodes[0].x = 120;
    const firstDelta = encodeBoardChange(state, first);
    const latest = fixture(); latest.nodes[0].x = 240;
    const latestDelta = encodeBoardChange(state, latest, [firstDelta]);
    const peer = fixture(); peer.nodes[1].y = 800;
    const peerDelta = encodeBoardChange(state, peer);
    for (const order of [[firstDelta, latestDelta, peerDelta], [latestDelta, peerDelta, firstDelta]]) {
      const server = new Y.Doc(); Y.applyUpdate(server, state);
      for (const update of order) Y.applyUpdate(server, update);
      const result = readBoardDocument(server, 3, fixture().updatedAt);
      expect(result.nodes.find(node => node.id === "a")?.x).toBe(240);
      expect(result.nodes.find(node => node.id === "b")?.y).toBe(800);
      server.destroy();
    }
    initial.destroy();
  }
});

it("retains causal predecessors until the UI has observed the acknowledged revision", () => {
  const pending = new BoardSaveCausality();
  expect(pending.record("board", "epoch", "first")).toBe(true);
  expect(pending.record("board", "epoch", "first", 5)).toBe(false);
  pending.record("board", "epoch", "second");
  expect(pending.prior("board", "epoch", 4)).toEqual(["first", "second"]);
  expect(pending.prior("board", "epoch", 5)).toEqual(["second"]);
  expect(pending.prior("board", "restored", 5)).toEqual([]);
});
