export interface BoardFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}
export interface BoardLibraryState {
  version: 1;
  revision: number;
  folders: BoardFolder[];
  boardFolders: Record<string, string>;
}
export type LibraryItem = { kind: "board" | "folder"; id: string };
export type BoardLibraryAction =
  | { type: "createFolder"; name: string; parentId: string | null; id?: string }
  | { type: "renameFolder"; id: string; name: string }
  | { type: "move"; items: LibraryItem[]; parentId: string | null }
  | { type: "deleteEmptyFolder"; id: string };
export interface BoardLibraryMutation {
  expectedRevision: number;
  action: BoardLibraryAction;
}
export const emptyBoardLibrary = (): BoardLibraryState => ({
  version: 1,
  revision: 0,
  folders: [],
  boardFolders: {},
});
export class BoardLibraryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function folderAncestors(
  state: BoardLibraryState,
  id: string | null,
): BoardFolder[] {
  const result: BoardFolder[] = [],
    visited = new Set<string>();
  while (id) {
    if (visited.has(id)) throw new BoardLibraryError("文件夹结构无效。");
    visited.add(id);
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) throw new BoardLibraryError("文件夹不存在，请刷新后重试。");
    result.unshift(folder);
    id = folder.parentId;
  }
  return result;
}

function folderName(value: string): string {
  if (typeof value !== "string")
    throw new BoardLibraryError("文件夹名称无效。");
  const name = value.trim();
  if (
    !name ||
    name.length > 120 ||
    /[<>:"/\\|?*]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32) ||
    /[. ]$/.test(name) ||
    name === "." ||
    name === ".." ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new BoardLibraryError("请使用有效的文件夹名称（最多 120 个字符）。");
  return name;
}

/** Changes only organization metadata; board contents and asset paths stay intact. */
export function mutateBoardLibrary(
  current: BoardLibraryState,
  input: BoardLibraryMutation,
  boardIds: Set<string>,
  newId: string,
): BoardLibraryState {
  if (
    !input ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision !== current.revision
  )
    throw new BoardLibraryError("目录已被更新，请刷新后重试。", 409);
  const next = structuredClone(current),
    action = input.action;
  if (!action || typeof action !== "object")
    throw new BoardLibraryError("目录操作无效。");
  const requireFolder = (id: string) => {
    const folder = next.folders.find((f) => f.id === id);
    if (!folder) throw new BoardLibraryError("文件夹不存在，请刷新后重试。");
    return folder;
  };
  const parent = (id: string | null) => {
    if (id !== null && (typeof id !== "string" || !id))
      throw new BoardLibraryError("目标文件夹无效。");
    if (id) requireFolder(id);
  };
  const unique = (name: string, parentId: string | null, except?: string) => {
    if (
      next.folders.some(
        (f) =>
          f.id !== except &&
          f.parentId === parentId &&
          f.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      throw new BoardLibraryError("此位置已有同名文件夹。");
  };
  switch (action.type) {
    case "createFolder": {
      parent(action.parentId);
      const name = folderName(action.name),
        id = action.id ?? newId;
      if (
        typeof id !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(id) ||
        next.folders.some((f) => f.id === id)
      )
        throw new BoardLibraryError("文件夹标识无效或已存在。");
      unique(name, action.parentId);
      next.folders.push({
        id,
        name,
        parentId: action.parentId,
        createdAt: new Date().toISOString(),
      });
      break;
    }
    case "renameFolder": {
      const folder = requireFolder(action.id),
        name = folderName(action.name);
      unique(name, folder.parentId, folder.id);
      folder.name = name;
      break;
    }
    case "move": {
      parent(action.parentId);
      if (
        !Array.isArray(action.items) ||
        !action.items.length ||
        action.items.length > 1000 ||
        action.items.some(item => !item || typeof item.id !== "string" || !item.id || !["board", "folder"].includes(item.kind))
      )
        throw new BoardLibraryError("请选择要移动的项目（最多 1000 项）。");
      const movingFolders = new Set(
        action.items.filter((i) => i.kind === "folder").map((i) => i.id),
      );
      if (
        folderAncestors(next, action.parentId).some((f) =>
          movingFolders.has(f.id),
        )
      )
        throw new BoardLibraryError("不能将文件夹移入自身或其子文件夹。");
      // Nested selections travel with their parent rather than being flattened.
      for (const item of action.items) {
        if (item.kind === "folder") {
          const folder = requireFolder(item.id);
          if (
            folderAncestors(next, folder.parentId).some((f) =>
              movingFolders.has(f.id),
            )
          )
            continue;
          unique(folder.name, action.parentId, folder.id);
          folder.parentId = action.parentId;
        } else if (item.kind === "board") {
          if (!boardIds.has(item.id))
            throw new BoardLibraryError("所选画板不存在或已移入回收站。");
          const existingParent = next.boardFolders[item.id] ?? null;
          if (
            folderAncestors(current, existingParent).some((f) =>
              movingFolders.has(f.id),
            )
          )
            continue;
          if (action.parentId) next.boardFolders[item.id] = action.parentId;
          else delete next.boardFolders[item.id];
        } else throw new BoardLibraryError("项目类型无效。");
      }
      break;
    }
    case "deleteEmptyFolder": {
      requireFolder(action.id);
      if (
        next.folders.some((f) => f.parentId === action.id) ||
        Object.entries(next.boardFolders).some(
          ([id, folder]) => folder === action.id && boardIds.has(id),
        )
      )
        throw new BoardLibraryError(
          "请先移出文件夹中的画板和子文件夹，再删除空文件夹。",
        );
      next.folders = next.folders.filter((f) => f.id !== action.id);
      for (const [id, folder] of Object.entries(next.boardFolders))
        if (folder === action.id) delete next.boardFolders[id];
      break;
    }
    default:
      throw new BoardLibraryError("目录操作无效。");
  }
  next.revision++;
  return next;
}
