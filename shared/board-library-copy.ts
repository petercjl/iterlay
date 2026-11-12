import type { BoardData } from "./types.js";
import {
  BoardLibraryError,
  folderAncestors,
  mutateBoardLibrary,
  type BoardLibraryMutation,
  type BoardLibraryState,
} from "./board-library.js";

/** Plan the entire copy before committing: stable assets, new boards and internal links. */
export function planBoardLibraryCopy(
  state: BoardLibraryState,
  input: BoardLibraryMutation,
  boards: BoardData[],
  uuid: () => string,
) {
  if (input.action?.type !== "copy")
    throw new BoardLibraryError("复制操作无效。");
  const { items, parentId } = input.action;
  const ids = new Set(boards.filter((b) => !b.parentBoardId).map((b) => b.id));
  // Reuse move validation for scope, item existence and self/descendant checks.
  mutateBoardLibrary(
    { ...state, folders: state.folders.map((f) => ({ ...f, name: f.id })) },
    { ...input, action: { type: "move", items, parentId } },
    ids,
    uuid(),
  );
  const next = structuredClone(state);
  const selectedFolders = new Set(
    items.filter((i) => i.kind === "folder").map((i) => i.id),
  );
  const topFolders = state.folders.filter(
    (f) =>
      selectedFolders.has(f.id) &&
      !folderAncestors(state, f.parentId).some((a) =>
        selectedFolders.has(a.id),
      ),
  );
  const includedFolders = state.folders.filter((f) =>
    folderAncestors(state, f.id).some((a) => selectedFolders.has(a.id)),
  );
  const folderIds = new Map(includedFolders.map((f) => [f.id, uuid()]));
  const uniqueName = (name: string, siblings: string[]) => {
    const used = new Set(siblings.map((n) => n.toLocaleLowerCase()));
    if (!used.has(name.toLocaleLowerCase())) return name;
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? " 副本" : ` 副本 ${n}`;
      const candidate = name.slice(0, 120 - suffix.length) + suffix;
      if (!used.has(candidate.toLocaleLowerCase())) return candidate;
    }
  };
  for (const folder of includedFolders) {
    const target = topFolders.some((f) => f.id === folder.id)
      ? parentId
      : folderIds.get(folder.parentId!)!;
    const name = uniqueName(
      folder.name,
      next.folders.filter((f) => f.parentId === target).map((f) => f.name),
    );
    next.folders.push({
      ...folder,
      id: folderIds.get(folder.id)!,
      parentId: target,
      name,
      createdAt: new Date().toISOString(),
    });
  }
  const selectedBoards = new Set(
    items.filter((i) => i.kind === "board").map((i) => i.id),
  );
  const roots = boards.filter(
    (b) =>
      !b.parentBoardId &&
      (selectedBoards.has(b.id) || folderIds.has(state.boardFolders[b.id])),
  );
  const included = new Set(roots.map((b) => b.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const b of boards)
      if (
        b.parentBoardId &&
        included.has(b.parentBoardId) &&
        !included.has(b.id)
      ) {
        included.add(b.id);
        changed = true;
      }
  }
  if (included.size > 1000 || includedFolders.length > 1000)
    throw new BoardLibraryError("一次最多复制 1000 个画板或文件夹。");
  const sources = boards.filter((b) => included.has(b.id));
  const remap = new Map<string, string>();
  for (const b of sources) {
    remap.set(b.id, uuid());
    for (const n of b.nodes) remap.set(n.id, uuid());
    for (const c of b.connections ?? []) remap.set(c.id, uuid());
    for (const g of b.groups ?? []) remap.set(g.id, uuid());
  }
  const replace = (value: unknown): unknown =>
    typeof value === "string"
      ? (remap.get(value) ?? value)
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, replace(v)]),
            )
          : value;
  const names = new Map<string | null, string[]>();
  for (const b of boards.filter((b) => !b.parentBoardId)) {
    const at = state.boardFolders[b.id] ?? null;
    names.set(at, [...(names.get(at) ?? []), b.name]);
  }
  const copies = sources.map((source) => {
    const copy = replace(source) as BoardData;
    copy.revision = 0;
    copy.createdAt = copy.updatedAt = new Date().toISOString();
    if (!source.parentBoardId) {
      const at = folderIds.get(state.boardFolders[source.id]) ?? parentId;
      copy.name = uniqueName(source.name, names.get(at) ?? []);
      names.set(at, [...(names.get(at) ?? []), copy.name]);
      if (at) next.boardFolders[copy.id] = at;
    }
    return copy;
  });
  next.revision++;
  return { library: next, boards: copies };
}
