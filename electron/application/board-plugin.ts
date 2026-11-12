import { createHash } from "node:crypto";
import type { BoardData, BoardNode, BoardTextNode } from "../../shared/types.js";
import { isBoardImageNode } from "../../shared/types.js";
import { parseInlineMediaDataUrl } from "../../shared/media-import.js";
import { imageDimensionsFromHeader } from "../media/image-metadata.js";
import type { WorkspaceApi } from "./workbench-api.js";

type Args = Record<string, unknown>;
type Tagged = BoardNode & { pluginOperation?: { id: string; hash: string } };
export const BOARD_PLUGIN_WRITES = new Set(["rename_board", "trash_board", "restore_board", "list_trashed_boards", "import_board_images", "write_board_text", "move_board_nodes"]);
function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 100000) throw new Error(`INVALID_ARGUMENT: ${label}`);
  return value;
}
function finite(value: unknown, fallback: number, min = -1e7, max = 1e7) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("INVALID_ARGUMENT: coordinate or dimension");
  return value;
}
function bounds(node: BoardNode) {
  const width = node.displayWidth ?? 264;
  return { x: node.x, y: node.y, width, height: isBoardImageNode(node) && node.width && node.height ? width * node.height / node.width : node.displayHeight ?? 240 };
}
function avoidExisting(board: BoardData, point: { x: number; y: number }, width: number, height: number, gap: number) {
  const placed = { ...point };
  for (let i = 0; i <= board.nodes.length; i++) {
    const collisions = board.nodes.map(bounds).filter(b => placed.x < b.x + b.width + gap && placed.x + width + gap > b.x && placed.y < b.y + b.height + gap && placed.y + height + gap > b.y);
    if (!collisions.length) return placed;
    placed.y = Math.max(...collisions.map(b => b.y + b.height)) + gap;
  }
  return placed;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Args)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function origin(board: BoardData, a: Args, gap: number) {
  if ((a.x === undefined) !== (a.y === undefined)) throw new Error("INVALID_ARGUMENT: x and y must be provided together");
  if (a.side !== undefined && !["right", "below"].includes(String(a.side))) throw new Error("INVALID_ARGUMENT: side");
  if (a.x !== undefined && a.anchorNodeId !== undefined) throw new Error("INVALID_ARGUMENT: choose coordinates or anchor");
  if (a.x !== undefined) return { x: finite(a.x, 0), y: finite(a.y, 0) };
  if (a.anchorNodeId !== undefined) {
    const node = board.nodes.find(n => n.id === a.anchorNodeId);
    if (!node) throw new Error("NODE_NOT_FOUND: anchor");
    const b = bounds(node);
    return a.side === "right" ? { x: b.x + b.width + gap, y: b.y } : { x: b.x, y: b.y + b.height + gap };
  }
  return { x: board.nodes.length ? Math.max(...board.nodes.map(n => n.x + bounds(n).width)) + gap : 0,
    y: board.nodes.length ? Math.min(...board.nodes.map(n => n.y)) : 0 };
}

export function boardPluginInputHash(method: string, args: Args) {
  return createHash("sha256").update(canonical({ method, ...args })).digest("hex");
}

/** Only board services; no provider, prompt-agent or media-generation dependencies. */
export async function executeBoardPluginWrite(api: WorkspaceApi, method: string, a: Args) {
  if (method === "list_trashed_boards") return api.listTrashedBoards();
  const boardId = text(a.boardId, "boardId");
  if (method === "rename_board") return api.renameBoard(boardId, text(a.name, "name"));
  if (method === "trash_board") return api.deleteBoard(boardId);
  if (method === "restore_board") return api.restoreBoard(boardId);
  const board = await api.getBoard(boardId);
  if (!board) throw new Error("BOARD_NOT_FOUND");
  let nodes: BoardNode[];
  let result: unknown;
  if (method === "move_board_nodes") {
    if (!Number.isInteger(a.expectedRevision) || a.expectedRevision !== (board.revision ?? 0)) throw new Error("BOARD_REVISION_CONFLICT: read the board again");
    if (!Array.isArray(a.positions) || !a.positions.length || a.positions.length > 1000) throw new Error("INVALID_ARGUMENT: positions");
    const positions = new Map<string, { x: number; y: number }>();
    for (const value of a.positions) {
      if (!value || typeof value !== "object") throw new Error("INVALID_ARGUMENT: position");
      const p = value as Args, id = text(p.nodeId, "nodeId");
      const node = board.nodes.find(n => n.id === id);
      if (!node || (node.type !== "text" && !isBoardImageNode(node))) throw new Error("NODE_NOT_FOUND: editable image/text");
      if (node.locked) throw new Error("NODE_LOCKED");
      if (positions.has(id) || p.x === undefined || p.y === undefined) throw new Error("INVALID_ARGUMENT: duplicate or incomplete position");
      positions.set(id, { x: finite(p.x, 0), y: finite(p.y, 0) });
    }
    nodes = board.nodes.map(n => positions.has(n.id) ? { ...n, ...positions.get(n.id)! } : n);
    result = { boardId, nodeIds: [...positions.keys()] };
  } else {
    const operationId = text(a.operationId, "operationId");
    if (operationId.length > 200) throw new Error("INVALID_ARGUMENT: operationId too long");
    const hash = boardPluginInputHash(method, a);
    const previous = (board.nodes as Tagged[]).filter(n => n.pluginOperation?.id === operationId);
    if (previous.length) {
      if (previous.some(n => n.pluginOperation?.hash !== hash)) throw new Error("OPERATION_ID_CONFLICT");
      return { boardId, nodeIds: previous.map(n => n.id), nodes: previous, reused: true };
    }
    const tag = { id: operationId, hash };
    const nodeId = (index: number) => "plugin-" + createHash("sha256").update(`${boardId}\0${operationId}\0${index}`).digest("hex").slice(0, 32);
    const width = finite(a.displayWidth, 300, 120, 1200);
    const gap = finite(a.gap, 40, 0, 1000);
    let start = origin(board, a, gap);
    let added: Tagged[];
    if (method === "write_board_text") {
      const existing = a.nodeId === undefined ? undefined : board.nodes.find(n => n.id === a.nodeId);
      if (a.nodeId !== undefined && existing?.type !== "text") throw new Error("NODE_NOT_FOUND: text");
      if (existing?.locked) throw new Error("NODE_LOCKED");
      if (existing?.type === "text" && (typeof a.expectedText !== "string" || existing.text !== a.expectedText)) throw new Error("TEXT_CONFLICT: read the text again");
      if (!existing && a.x === undefined) start = avoidExisting(board, start, width, 240, gap);
      const node: BoardTextNode & Tagged = { ...(existing ?? { id: nodeId(0), type: "text", ...start, displayWidth: width, displayHeight: 240 }),
        type: "text", text: text(a.text, "text", true), pluginOperation: tag,
        ...(a.title === undefined ? {} : { title: text(a.title, "title", true) }) };
      added = [node];
      nodes = existing ? board.nodes.map(n => n.id === existing.id ? node : n) : [...board.nodes, node];
    } else if (method === "import_board_images") {
      if (!Array.isArray(a.images) || !a.images.length || a.images.length > 30) throw new Error("INVALID_ARGUMENT: images");
      const columns = finite(a.columns, Math.min(3, a.images.length), 1, 30);
      if (!Number.isInteger(columns)) throw new Error("INVALID_ARGUMENT: columns");
      const inputs = a.images.map(value => {
        const data = parseInlineMediaDataUrl(value, "image");
        const size = imageDimensionsFromHeader(Buffer.from(data.dataBase64, "base64"));
        if (!size || !size.width || !size.height) throw new Error("INVALID_IMAGE: dimensions");
        return { ...data, ...size };
      });
      if (inputs.reduce((total, input) => total + Buffer.byteLength(input.dataBase64, "base64"), 0) > 20 * 1024 * 1024) throw new Error("BATCH_TOO_LARGE");
      let totalHeight = 0;
      for (let index = 0; index < inputs.length; index += columns) totalHeight += Math.max(...inputs.slice(index, index + columns).map(input => width * input.height / input.width)) + (index ? gap : 0);
      if (a.x === undefined) start = avoidExisting(board, start, Math.min(columns, inputs.length) * (width + gap) - gap, totalHeight, gap);
      added = [];
      let rowY = start.y, rowHeight = 0;
      for (const [index, input] of inputs.entries()) {
        if (index > 0 && index % columns === 0) { rowY += rowHeight + gap; rowHeight = 0; }
        const image = await api.importUploadedImage(input.dataUrl);
        const node: Tagged = { id: nodeId(index), type: "image", imagePath: image.path, jobId: "import-" + nodeId(index), source: "upload",
          width: input.width, height: input.height, displayWidth: width, x: start.x + (index % columns) * (width + gap), y: rowY, pluginOperation: tag };
        added.push(node);
        rowHeight = Math.max(rowHeight, width * input.height / input.width);
      }
      nodes = [...board.nodes, ...added];
    } else throw new Error("PLUGIN_CAPABILITY_DENIED");
    result = { boardId, nodeIds: added.map(n => n.id), nodes: added, reused: false };
  }
  await api.saveBoard({ id: boardId, expectedRevision: board.revision ?? 0, nodes });
  return { ...result as object, revision: (board.revision ?? 0) + 1 };
}
