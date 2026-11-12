import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { resolveBoardCover } from "../shared/board-cover";
import { rebaseBoardSnapshot } from "../shared/board-snapshot-merge";
import { createBoardDocument, readBoardDocument } from "../shared/enterprise-board";
import { BoardStore } from "../electron/storage/board-store";
import type { BoardData, BoardNodeSnapshot } from "../shared/types";
const image = (id: string): BoardNodeSnapshot => ({ id, type: "image", imagePath: `/images/${id}.png`, jobId: id, source: "upload", x: 0, y: 0, width: 100, height: 100 });
const board = (): BoardData => ({ id: "board", name: "cover", createdAt: "2026-11-13", updatedAt: "2026-11-13", revision: 1, nodes: [image("first"), image("second")] });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("board cover selection", () => {
  it("tries the next image after an unreadable first image", async () => {
    const encode = vi.fn(async (path: string) => { if (path.includes("first")) throw new Error("unavailable"); return "second-preview"; });
    expect(await resolveBoardCover(board(), encode)).toEqual({ coverNodeId: "", thumbnailDataUrl: "second-preview", thumbnailImagePath: image("second").imagePath });
    expect(encode).toHaveBeenCalledTimes(2);
  });
  it("retries the same source after a failed encode", async () => {
    const b = { ...board(), nodes: [image("first")] };
    const encode = vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("recovered");
    Object.assign(b, await resolveBoardCover(b, encode));
    expect((await resolveBoardCover(b, encode)).thumbnailDataUrl).toBe("recovered");
    expect(encode).toHaveBeenCalledTimes(2);
  });
  it("pins the selected node through additions and reordering, and refreshes its active version", async () => {
    const b = { ...board(), coverNodeId: "second", thumbnailImagePath: image("second").imagePath, thumbnailDataUrl: "cached" };
    b.nodes.reverse(); b.nodes.unshift(image("new"));
    const encode = vi.fn(async () => "updated-version");
    expect((await resolveBoardCover(b, encode)).thumbnailDataUrl).toBe("cached");
    expect(encode).not.toHaveBeenCalled();
    (b.nodes.find(n => n.id === "second") as BoardNodeSnapshot).imagePath = "/images/version2.png";
    expect(await resolveBoardCover(b, encode)).toMatchObject({ coverNodeId: "second", thumbnailDataUrl: "updated-version", thumbnailImagePath: "/images/version2.png" });
  });
  it("preserves the choice if temporarily unreadable and switches to automatic after deletion", async () => {
    const b = { ...board(), coverNodeId: "second" };
    expect(await resolveBoardCover(b, async () => "")).toMatchObject({ coverNodeId: "second", thumbnailDataUrl: "" });
    b.nodes = [image("first")];
    expect(await resolveBoardCover(b, async () => "auto")).toMatchObject({ coverNodeId: "", thumbnailDataUrl: "auto" });
    expect(await resolveBoardCover({ ...b, nodes: [] }, async () => "unused")).toEqual({ coverNodeId: "", thumbnailDataUrl: "", thumbnailImagePath: "" });
  });
  it("keeps a concurrent manual choice while rebasing automatic saves", () => {
    const base = board();
    const remote = { ...base, revision: 2, coverNodeId: "second", thumbnailImagePath: image("second").imagePath, thumbnailDataUrl: "chosen" };
    const local = { id: base.id, nodes: base.nodes, coverNodeId: "", thumbnailImagePath: image("first").imagePath, thumbnailDataUrl: "auto" };
    expect(rebaseBoardSnapshot(base, local, remote)).toMatchObject({ coverNodeId: "second", thumbnailDataUrl: "chosen", thumbnailImagePath: image("second").imagePath });
  });
  it("persists the choice in the enterprise collaborative document", () => {
    const b = { ...board(), coverNodeId: "second", thumbnailImagePath: image("second").imagePath, thumbnailDataUrl: "chosen" };
    const doc = createBoardDocument(b);
    const restored = new Y.Doc(); Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    expect(readBoardDocument(restored, 3, b.updatedAt)).toMatchObject({ coverNodeId: "second", thumbnailDataUrl: "chosen", thumbnailImagePath: image("second").imagePath });
    doc.destroy(); restored.destroy();
  });
  it("generates covers for CLI appends and preserves manual choice across restart, duplicate and deletion", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tuda-cover-test-")); dirs.push(dir);
    const encode = vi.fn(async (path: string) => `preview:${path}`);
    const store = new BoardStore(dir, undefined, undefined, encode);
    const created = await store.createBoard("cover");
    await store.appendNodes(created.id, [image("first"), image("second")]);
    expect(await store.getBoard(created.id)).toMatchObject({ thumbnailImagePath: image("first").imagePath, thumbnailDataUrl: `preview:${image("first").imagePath}` });
    await store.saveBoard({ id: created.id, coverNodeId: "second" });
    const restarted = new BoardStore(dir, undefined, undefined, encode);
    expect(await restarted.getBoard(created.id)).toMatchObject({ coverNodeId: "second", thumbnailImagePath: image("second").imagePath });
    await restarted.appendNodes(created.id, [image("new")]);
    expect(await restarted.getBoard(created.id)).toMatchObject({ coverNodeId: "second", thumbnailImagePath: image("second").imagePath });
    const copied = await restarted.duplicateBoard(created.id);
    expect(copied?.coverNodeId).toBe(copied?.nodes.find(n => n.type === "image" && n.imagePath === image("second").imagePath)?.id);
    await restarted.removeNodes(created.id, ["second"]);
    expect(await restarted.getBoard(created.id)).toMatchObject({ coverNodeId: "", thumbnailImagePath: image("first").imagePath });
  });
});
