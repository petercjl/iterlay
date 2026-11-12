import * as Y from "yjs";
import type { BoardData, BoardNode, BoardSavePayload } from "./types.js";

const collections = ["nodes", "connections", "groups"] as const;
const metadata = ["name", "kind", "parentBoardId", "thumbnailDataUrl", "videoSequences", "deliveryRecipes"] as const;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function updateText(text: Y.Text, next: string) {
  const before = text.toString();
  let start = 0;
  while (start < before.length && start < next.length && before[start] === next[start]) start++;
  let end = 0;
  while (end < before.length - start && end < next.length - start && before[before.length - 1 - end] === next[next.length - 1 - end]) end++;
  if (before.length - start - end) text.delete(start, before.length - start - end);
  const insert = next.slice(start, next.length - end);
  if (insert) text.insert(start, insert);
}

function writeItem(target: Y.Map<unknown>, item: Record<string, unknown>) {
  const current = target.toJSON() as Record<string, unknown>;
  const pose = { x: item.x, y: item.y };
  if (typeof item.x === "number" && !equal(target.get("pose"), pose)) target.set("pose", pose);
  for (const key of new Set([...Object.keys(current), ...Object.keys(item)])) {
    if (key === "pose" || key === "x" || key === "y") continue;
    const value = item[key];
    if (value === undefined) { if (target.has(key)) target.delete(key); continue; }
    if ((key === "text" || key === "code") && typeof value === "string") {
      let text = target.get(key);
      if (!(text instanceof Y.Text)) { text = new Y.Text(); target.set(key, text); }
      updateText(text as Y.Text, value);
    } else if (!equal(current[key], value)) target.set(key, clone(value));
  }
}

/** Mutates only fields represented by the caller's observed document and payload. */
export function patchBoardDocument(doc: Y.Doc, payload: BoardSavePayload) {
  doc.transact(() => {
    const meta = doc.getMap("metadata");
    for (const field of metadata) if (payload[field] !== undefined && !equal(meta.get(field), payload[field])) meta.set(field, clone(payload[field]));
    for (const field of collections) {
      const values = payload[field];
      if (!values) continue;
      const map = doc.getMap<Y.Map<unknown>>(field);
      const ids = new Set(values.map(item => item.id));
      for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
      for (const value of values) {
        let item = map.get(value.id);
        if (!item) { item = new Y.Map(); map.set(value.id, item); }
        writeItem(item, value as unknown as Record<string, unknown>);
      }
    }
  }, "local-board-edit");
}

export function createBoardDocument(board: BoardData): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("identity").set("id", board.id);
  doc.getMap("identity").set("createdAt", board.createdAt);
  patchBoardDocument(doc, board);
  return doc;
}

export function readBoardDocument(doc: Y.Doc, revision: number, updatedAt: string): BoardData {
  const identity = doc.getMap("identity");
  const meta = doc.getMap("metadata").toJSON();
  const read = (field: typeof collections[number]): Record<string, unknown>[] => [...doc.getMap<Y.Map<unknown>>(field).values()].map(item => {
    const { pose, ...value } = item.toJSON() as Record<string, unknown>;
    return { ...value, ...(pose && typeof pose === "object" ? pose : {}) };
  });
  const nodes = read("nodes") as unknown as BoardNode[];
  const ids = new Set(nodes.map(node => node.id));
  return { schemaVersion: 3, id: String(identity.get("id")), createdAt: String(identity.get("createdAt")), updatedAt,
    name: typeof meta.name === "string" ? meta.name : "未命名画板", kind: "standard", ...meta, revision, nodes,
    connections: read("connections").filter(edge => ids.has(String(edge.source)) && ids.has(String(edge.target))) as unknown as BoardData["connections"],
    groups: read("groups") as unknown as BoardData["groups"] };
}

export function encodeBoardChange(state: Uint8Array, payload: BoardSavePayload, prior: Uint8Array[] = []): Uint8Array {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    for (const update of prior) Y.applyUpdate(doc, update);
    const vector = Y.encodeStateVector(doc);
    patchBoardDocument(doc, payload);
    return Y.encodeStateAsUpdate(doc, vector);
  } finally { doc.destroy(); }
}
