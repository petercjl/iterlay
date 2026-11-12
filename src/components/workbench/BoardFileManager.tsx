import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  ChevronRight,
  ClipboardPaste,
  Folder,
  FolderInput,
  FolderPlus,
  Home,
  MoreHorizontal,
  Pencil,
  Scissors,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  folderAncestors,
  type BoardLibraryAction,
  type BoardLibraryState,
  type LibraryItem,
} from "@shared/board-library";
import { useUiText } from "@/i18n";
import {
  getImageWorkbenchApi,
  getWorkbenchErrorMessage,
} from "@/lib/image-workbench-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BoardLibrary, type BoardLibraryProps } from "./BoardLibrary";
import { useEnterpriseStatus } from "@/components/enterprise/use-enterprise";

interface Props extends Omit<
  BoardLibraryProps,
  "onCreateBoard" | "onImportBoard" | "onImportBoardFiles"
> {
  onFolderChange?: (folderId: string | null) => void;
  onCreateBoard: (folderId?: string | null) => void;
  onImportBoard: (folderId?: string | null) => Promise<void>;
  onImportBoardFiles: (
    files: File[],
    folderId?: string | null,
  ) => Promise<void>;
}
const DRAG_TYPE = "application/x-tuda-library";
const keyOf = (item: LibraryItem) => `${item.kind}:${item.id}`;

export function BoardFileManager(props: Props) {
  const t = useUiText(),
    space = useEnterpriseStatus();
  const { onInteractionLockChange, onFolderChange } = props;
  const [library, setLibrary] = useState<BoardLibraryState | null>(null);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    onFolderChange?.(current);
  }, [current, onFolderChange]);
  const [selected, setSelected] = useState<LibraryItem[]>([]);
  const [cut, setCut] = useState<LibraryItem[]>([]);
  const [copied, setCopied] = useState<LibraryItem[]>([]);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    items: LibraryItem[];
    parentId: string | null;
  } | null>(null);
  const [deleteItems, setDeleteItems] = useState<LibraryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [childLocked, setChildLocked] = useState(false);
  const [nameDialog, setNameDialog] = useState<{
    id?: string;
    kind: "folder" | "board";
    name: string;
    parentId?: string | null;
  } | null>(null);
  const [moveItems, setMoveItems] = useState<LibraryItem[] | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const request = useRef(0);
  const managerRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const dialogOpenRef = useRef(false);
  const drag = useRef<LibraryItem[] | null>(null);
  const readOnly =
    space?.activeSpace === "enterprise" && space.user?.role === "viewer";
  const locked = busy || childLocked || !library || Boolean(error);
  const boardKey = props.boards.map((b) => b.id).join("|");
  const scope = JSON.stringify([
    space?.activeSpace,
    space?.serverUrl,
    space?.user?.id,
    space?.storageKind,
    space?.localFolder,
    space?.storageUrl,
  ]);
  const reload = useCallback(async () => {
    const version = ++request.current;
    try {
      const value = await getImageWorkbenchApi().getBoardLibrary();
      if (version === request.current) {
        setLibrary(value);
        setError("");
      }
    } catch (e) {
      if (version === request.current) setError(getWorkbenchErrorMessage(e));
    }
  }, []);
  useEffect(() => {
    setLibrary(null);
    setCurrent(null);
    setSelected([]);
    setCut([]);
    setCopied([]);
    setContext(null);
    setHistory([]);
    void reload();
  }, [scope, reload]);
  useEffect(() => {
    void reload();
  }, [boardKey, reload]);
  useEffect(() => {
    if (space?.connected) void reload();
  }, [space?.connected, reload]);
  useEffect(() => {
    let stop = () => {};
    try {
      stop = getImageWorkbenchApi().onWorkbenchEvent((e) => {
        if (e.type === "library-updated") void reload();
      });
    } catch {
      /* Standalone previews have no desktop bridge; reload shows its connection error. */
    }
    const token = request;
    return () => {
      token.current++;
      stop();
    };
  }, [reload]);
  useEffect(() => {
    if (current && library && !library.folders.some((f) => f.id === current)) {
      setCurrent(null);
      setSelected([]);
    }
  }, [current, library]);
  const modal = Boolean(nameDialog || moveItems || deleteItems);
  dialogOpenRef.current = modal;
  useEffect(() => {
    onInteractionLockChange?.(locked || modal);
  }, [locked, modal, onInteractionLockChange]);
  useEffect(
    () => () => onInteractionLockChange?.(false),
    [onInteractionLockChange],
  );
  const onChildLock = useCallback(
    (value: boolean) => setChildLocked(value),
    [],
  );
  const folders = useMemo(
    () =>
      [...(library?.folders ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [library],
  );
  const ancestors =
    library && (!current || library.folders.some((f) => f.id === current))
      ? folderAncestors(library, current)
      : [];
  const visibleFolders = folders.filter((f) => f.parentId === current);
  const visibleBoards = props.boards.filter(
    (b) => (library?.boardFolders[b.id] ?? null) === current,
  );
  const selectedBoards = new Set(
    selected.filter((i) => i.kind === "board").map((i) => i.id),
  );
  const select = (item: LibraryItem, additive = false) =>
    setSelected((items) =>
      additive
        ? items.some((i) => keyOf(i) === keyOf(item))
          ? items.filter((i) => keyOf(i) !== keyOf(item))
          : [...items, item]
        : [item],
    );
  const navigate = (id: string | null) => {
    if (locked || modal) return;
    setHistory((h) => [...h, current]);
    setCurrent(id);
    setSelected([]);
  };
  async function mutate(action: BoardLibraryAction): Promise<boolean> {
    if (!library || readOnly || busy) return false;
    setBusy(true);
    try {
      const next = await getImageWorkbenchApi().updateBoardLibrary({
        expectedRevision: library.revision,
        action,
      });
      request.current++;
      setLibrary(next);
      setError("");
      return true;
    } catch (e) {
      toast.error(getWorkbenchErrorMessage(e));
      await reload();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function move(items: LibraryItem[], parentId: string | null) {
    if (await mutate({ type: "move", items, parentId })) {
      setMoveItems(null);
      setCut([]);
      setSelected([]);
    }
  }
  function startDrag(items: LibraryItem[], event: DragEvent<HTMLElement>) {
    if (locked || readOnly) {
      event.preventDefault();
      return;
    }
    drag.current = items;
    event.dataTransfer.setData(DRAG_TYPE, "tuda");
    event.dataTransfer.effectAllowed = "move";
  }
  function dropTarget(parentId: string | null) {
    return {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (
          event.dataTransfer.types.includes(DRAG_TYPE) &&
          drag.current &&
          !locked &&
          !readOnly
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE) || !drag.current)
          return;
        event.preventDefault();
        event.stopPropagation();
        const items = drag.current;
        drag.current = null;
        void move(items, parentId);
      },
    };
  }
  const nameOf = (item: LibraryItem) =>
    item.kind === "folder"
      ? folders.find((f) => f.id === item.id)?.name
      : props.boards.find((b) => b.id === item.id)?.name;
  const destinationFolders = folders.filter(
    (f) =>
      !folderAncestors(library!, f.id).some((a) =>
        moveItems?.some((i) => i.kind === "folder" && i.id === a.id),
      ),
  );
  const tree = (parentId: string | null, depth = 0): React.ReactNode =>
    folders
      .filter((f) => f.parentId === parentId)
      .map((folder) => (
        <div key={folder.id}>
          <button
            data-library-folder-id={folder.id}
            type="button"
            disabled={locked || modal}
            onClick={() => navigate(folder.id)}
            {...dropTarget(folder.id)}
            className={`flex w-full items-center gap-2 rounded-md py-2 pr-2 text-left text-xs hover:bg-accent ${current === folder.id ? "bg-blue-500/10 text-blue-600" : "text-muted-foreground"}`}
            style={{ paddingLeft: 12 + depth * 14 }}
          >
            <Folder className="h-4 w-4 shrink-0" />
            <span className="truncate">{folder.name}</span>
          </button>
          {tree(folder.id, depth + 1)}
        </div>
      ));
  async function paste(parentId: string | null) {
    if (cut.length) await move(cut, parentId);
    else if (
      copied.length &&
      (await mutate({ type: "copy", items: copied, parentId }))
    )
      setSelected([]);
  }
  async function confirmDelete() {
    if (!deleteItems || !library || busy || readOnly) return;
    setBusy(true);
    try {
      const selectedFolders = new Set(
        deleteItems.filter((i) => i.kind === "folder").map((i) => i.id),
      );
      const removedFolders = folders.filter((f) =>
        folderAncestors(library, f.id).some((a) => selectedFolders.has(a.id)),
      );
      const folderIds = new Set(removedFolders.map((f) => f.id));
      const boardIds = new Set(
        deleteItems.filter((i) => i.kind === "board").map((i) => i.id),
      );
      for (const b of props.boards)
        if (folderIds.has(library.boardFolders[b.id])) boardIds.add(b.id);
      for (const id of boardIds) await props.onDeleteBoard(id);
      for (const f of removedFolders.sort(
        (a, b) =>
          folderAncestors(library, b.id).length -
          folderAncestors(library, a.id).length,
      )) {
        const state = await getImageWorkbenchApi().getBoardLibrary();
        await getImageWorkbenchApi().updateBoardLibrary({
          expectedRevision: state.revision,
          action: { type: "deleteEmptyFolder", id: f.id },
        });
      }
      setDeleteItems(null);
      setSelected([]);
      setCut([]);
      setCopied([]);
      await reload();
    } catch (e) {
      toast.error(getWorkbenchErrorMessage(e));
      await reload();
    } finally {
      setBusy(false);
    }
  }
  function menuEntries(items: LibraryItem[], parentId: string | null) {
    const one = items.length === 1 ? items[0] : undefined;
    return (
      <>
        {one && (
          <DropdownMenuItem
            onSelect={() => {
              if (one.kind === "folder") navigate(one.id);
              else props.onOpenBoard(one.id);
            }}
          >
            {t("打开")}
          </DropdownMenuItem>
        )}
        {items.length > 0 && (
          <>
            <DropdownMenuItem
              disabled={readOnly || locked}
              onSelect={() => {
                setCopied(items);
                setCut([]);
              }}
            >
              <Copy className="h-4 w-4" />
              {t("复制")}
              <span className="ml-auto text-xs text-muted-foreground">
                ⌘ / Ctrl C
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly || locked}
              onSelect={() => {
                setCut(items);
                setCopied([]);
              }}
            >
              <Scissors className="h-4 w-4" />
              {t("剪切")}
              <span className="ml-auto text-xs text-muted-foreground">
                ⌘ / Ctrl X
              </span>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          disabled={readOnly || locked || !(cut.length || copied.length)}
          onSelect={() => void paste(parentId)}
        >
          <ClipboardPaste className="h-4 w-4" />
          {t("粘贴")}
          <span className="ml-auto text-xs text-muted-foreground">
            ⌘ / Ctrl V
          </span>
        </DropdownMenuItem>
        {items.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={readOnly || locked || !one}
              onSelect={() =>
                one &&
                setNameDialog({
                  id: one.id,
                  kind: one.kind,
                  name: nameOf(one) ?? "",
                })
              }
            >
              <Pencil className="h-4 w-4" />
              {t("重命名")}
              <span className="ml-auto text-xs text-muted-foreground">F2</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly || locked}
              onSelect={() => {
                setMoveItems(items);
                setDestination(current);
              }}
            >
              <FolderInput className="h-4 w-4" />
              {t("移动到…")}
            </DropdownMenuItem>
            {one?.kind === "board" && (
              <DropdownMenuItem onSelect={() => props.onExportBoard(one.id)}>
                {t("导出 .itb")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={readOnly || locked}
              onSelect={() => setDeleteItems(items)}
            >
              <Trash2 className="h-4 w-4" />
              {t("删除")}
              <span className="ml-auto text-xs text-muted-foreground">
                Delete
              </span>
            </DropdownMenuItem>
          </>
        )}
        {(items.length === 0 || one?.kind === "folder") && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={readOnly || locked}
              onSelect={() => props.onCreateBoard(parentId)}
            >
              {t("新建画板")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly || locked}
              onSelect={() =>
                setNameDialog({ kind: "folder", name: "", parentId })
              }
            >
              <FolderPlus className="h-4 w-4" />
              {t("新建文件夹")}
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  }
  function itemMenu(items: LibraryItem[]) {
    const item = items[0];
    const targets = selected.some((i) => keyOf(i) === keyOf(item))
      ? selected
      : items;
    const parentId = item.kind === "folder" ? item.id : current;
    return (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            disabled={locked}
            aria-label={t(
              item.kind === "folder"
                ? "文件夹 {{ui:0}} 操作"
                : "画板 {{ui:0}} 操作",
              [nameOf(item) ?? ""],
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {menuEntries(targets, parentId)}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <div
      ref={managerRef}
      tabIndex={-1}
      className="h-full min-h-0 outline-none"
      data-board-file-manager
      onContextMenu={(event) => {
        if (
          (event.target as HTMLElement).closest(
            "input:not([type=checkbox]),textarea,[contenteditable=true],[role=menu]",
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (locked || modal) return;
        const target = event.target as HTMLElement;
        const board = target.closest<HTMLElement>("[data-board-library-id]");
        const folder = target.closest<HTMLElement>("[data-library-folder-id]");
        const item: LibraryItem | null = board
          ? { kind: "board", id: board.dataset.boardLibraryId! }
          : folder?.dataset.libraryFolderId
            ? { kind: "folder", id: folder.dataset.libraryFolderId }
            : null;
        const items = item
          ? selected.some((i) => keyOf(i) === keyOf(item))
            ? selected
            : [item]
          : [];
        setSelected(items);
        setContext({
          x: event.clientX,
          y: event.clientY,
          items,
          parentId: folder ? folder.dataset.libraryFolderId || null : current,
        });
      }}
      onDragEnd={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (
          (event.target as HTMLElement).closest(
            "input:not([type=checkbox]),textarea,select,[contenteditable=true]",
          ) ||
          modal ||
          locked
        )
          return;
        const command = event.metaKey || event.ctrlKey;
        if (command && event.key.toLowerCase() === "a") {
          event.preventDefault();
          event.stopPropagation();
          setSelected([
            ...visibleFolders.map((f) => ({
              kind: "folder" as const,
              id: f.id,
            })),
            ...visibleBoards.map((b) => ({ kind: "board" as const, id: b.id })),
          ]);
        }
        if (command && event.key.toLowerCase() === "x" && !readOnly) {
          event.preventDefault();
          setCut(selected);
          setCopied([]);
        }
        if (command && event.key.toLowerCase() === "c" && !readOnly) {
          event.preventDefault();
          setCopied(selected);
          setCut([]);
        }
        if (event.key === "Delete" && selected.length && !readOnly) {
          event.preventDefault();
          setDeleteItems(selected);
        }
        if (
          command &&
          event.key.toLowerCase() === "v" &&
          (cut.length || copied.length) &&
          !readOnly
        ) {
          event.preventDefault();
          void paste(current);
        }
        if (event.key === "F2" && selected.length === 1 && !readOnly) {
          event.preventDefault();
          event.stopPropagation();
          setNameDialog({
            id: selected[0].id,
            kind: selected[0].kind,
            name: nameOf(selected[0]) ?? "",
          });
        }
      }}
    >
      <BoardLibrary
        {...props}
        hideCreateAction
        renderItemMenu={(id) => itemMenu([{ kind: "board", id }])}
        boards={visibleBoards}
        externalBusy={busy || !library || Boolean(error)}
        onInteractionLockChange={onChildLock}
        onCreateBoard={() => props.onCreateBoard(current)}
        onImportBoard={() => props.onImportBoard(current)}
        onImportBoardFiles={(files) => props.onImportBoardFiles(files, current)}
        selectedIds={selectedBoards}
        onSelectBoard={(id, additive) =>
          select({ kind: "board", id }, additive)
        }
        onMoveBoard={
          readOnly
            ? undefined
            : (board) => {
                setMoveItems([{ kind: "board", id: board.id }]);
                setDestination(current);
              }
        }
        onDragBoard={
          readOnly
            ? undefined
            : (id, event) =>
                startDrag(
                  selectedBoards.has(id) ? selected : [{ kind: "board", id }],
                  event,
                )
        }
        sidebar={
          <aside
            aria-label={t("文件夹导航")}
            className="hidden w-44 shrink-0 overflow-y-auto border-r bg-background/50 p-2 md:block"
          >
            <Button
              size="sm"
              variant="outline"
              className="mb-3 w-full justify-start gap-2 border-blue-200/70 bg-background/80 text-blue-700 hover:bg-blue-50 dark:border-blue-900 dark:text-blue-300 dark:hover:bg-blue-950"
              disabled={locked || readOnly}
              onClick={() => setNameDialog({ kind: "folder", name: "" })}
            >
              <FolderPlus className="h-4 w-4" />
              {t("新建文件夹")}
            </Button>
            <button
              type="button"
              disabled={locked || modal}
              data-library-folder-id=""
              onClick={() => navigate(null)}
              {...dropTarget(null)}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs ${current === null ? "bg-blue-500/10 text-blue-600" : "hover:bg-accent"}`}
            >
              <Home className="h-4 w-4" />
              {t("根目录")}
            </button>
            {tree(null)}
          </aside>
        }
        navigation={
          <div className="shrink-0 border-b bg-background/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={t("后退")}
                disabled={!history.length || locked || modal}
                onClick={() => {
                  setCurrent(history.at(-1) ?? null);
                  setHistory((h) => h.slice(0, -1));
                  setSelected([]);
                }}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label={t("上一级")}
                disabled={!current || locked || modal}
                onClick={() => navigate(ancestors.at(-1)?.parentId ?? null)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <nav
                aria-label={t("文件夹路径")}
                className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs"
              >
                <button
                  disabled={locked || modal}
                  {...dropTarget(null)}
                  onClick={() => navigate(null)}
                  className="rounded px-2 py-1 hover:bg-accent"
                >
                  {t("画板库")}
                </button>
                {ancestors.map((f) => (
                  <span key={f.id} className="flex min-w-0 items-center gap-1">
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <button
                      disabled={locked || modal}
                      onClick={() => navigate(f.id)}
                      {...dropTarget(f.id)}
                      className="max-w-40 truncate rounded px-2 py-1 hover:bg-accent"
                    >
                      {f.name}
                    </button>
                  </span>
                ))}
              </nav>
              <Button
                size="sm"
                variant="outline"
                className="md:hidden"
                disabled={locked || readOnly}
                onClick={() => setNameDialog({ kind: "folder", name: "" })}
              >
                <FolderPlus className="mr-1.5 h-4 w-4" />
                {t("新建文件夹")}
              </Button>
            </div>
            {error ? (
              <div
                role="alert"
                className="mt-2 flex items-center gap-2 text-xs text-destructive"
              >
                <span>{error}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void reload()}
                >
                  {t("重试")}
                </Button>
              </div>
            ) : null}
            <div className="mt-2 flex min-h-8 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {selected.length
                  ? t("已选择 {{ui:0}} 项", [selected.length])
                  : t("双击打开 · 拖入文件夹移动")}
              </span>
              {selected.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked || readOnly}
                    onClick={() => {
                      setMoveItems(selected);
                      setDestination(current);
                    }}
                  >
                    <FolderInput className="mr-1 h-3.5 w-3.5" />
                    {t("移动到…")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked || readOnly}
                    onClick={() => {
                      setCut(selected);
                      setCopied([]);
                    }}
                  >
                    <Scissors className="mr-1 h-3.5 w-3.5" />
                    {t("剪切")}
                  </Button>
                </>
              )}
              {(cut.length > 0 || copied.length > 0) && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked || readOnly}
                    onClick={() => void paste(current)}
                  >
                    <ClipboardPaste className="mr-1 h-3.5 w-3.5" />
                    {t("粘贴 {{ui:0}} 项", [cut.length || copied.length])}
                  </Button>
                  <button
                    onClick={() => {
                      setCut([]);
                      setCopied([]);
                    }}
                  >
                    {t("清空剪贴板")}
                  </button>
                </>
              )}
            </div>
            {visibleFolders.length > 0 && (
              <div
                aria-label={t("子文件夹")}
                className="mt-2 grid max-h-48 grid-cols-2 gap-2 overflow-y-auto lg:grid-cols-3 xl:grid-cols-4"
              >
                {visibleFolders.map((folder) => {
                  const chosen = selected.some(
                    (i) => i.kind === "folder" && i.id === folder.id,
                  );
                  return (
                    <div
                      key={folder.id}
                      data-library-folder-id={folder.id}
                      draggable={!locked && !readOnly}
                      onDragStart={(event) =>
                        startDrag(
                          chosen
                            ? selected
                            : [{ kind: "folder", id: folder.id }],
                          event,
                        )
                      }
                      {...dropTarget(folder.id)}
                      className={`relative flex min-w-0 items-center gap-2 rounded-lg border p-2 ${chosen ? "border-blue-500 bg-blue-500/5" : "bg-background hover:bg-accent"}`}
                    >
                      <button
                        type="button"
                        aria-label={t("打开文件夹 {{ui:0}}", [folder.name])}
                        disabled={locked || modal}
                        onClick={(event) =>
                          select(
                            { kind: "folder", id: folder.id },
                            event.metaKey || event.ctrlKey || event.shiftKey,
                          )
                        }
                        onDoubleClick={() => navigate(folder.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            navigate(folder.id);
                          }
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Folder className="h-7 w-7 shrink-0 fill-blue-500/15 text-blue-500" />
                        <span className="truncate text-xs">{folder.name}</span>
                      </button>
                      {chosen && <Check className="h-3 w-3 text-blue-500" />}
                      {itemMenu([{ kind: "folder", id: folder.id }])}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        }
      />
      <Dialog
        open={Boolean(nameDialog)}
        onOpenChange={(open) => {
          if (!open && !busy) setNameDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(nameDialog?.id ? "重命名" : "新建文件夹")}
            </DialogTitle>
            <DialogDescription>
              {t("输入名称，按 Enter 确认。")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!nameDialog || busy) return;
              if (nameDialog.kind === "board" && nameDialog.id) {
                props.onRenameBoard(nameDialog.id, nameDialog.name);
                setNameDialog(null);
                return;
              }
              void mutate(
                nameDialog.id
                  ? {
                      type: "renameFolder",
                      id: nameDialog.id,
                      name: nameDialog.name,
                    }
                  : {
                      type: "createFolder",
                      parentId:
                        nameDialog.parentId === undefined
                          ? current
                          : nameDialog.parentId,
                      name: nameDialog.name,
                    },
              ).then((ok) => {
                if (ok) setNameDialog(null);
              });
            }}
          >
            <Input
              autoFocus
              aria-label={t("名称")}
              value={nameDialog?.name ?? ""}
              maxLength={120}
              onChange={(event) =>
                setNameDialog((value) =>
                  value ? { ...value, name: event.target.value } : value,
                )
              }
            />
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setNameDialog(null)}
              >
                {t("取消")}
              </Button>
              <Button type="submit" disabled={busy || !nameDialog?.name.trim()}>
                {t("确定")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(moveItems)}
        onOpenChange={(open) => {
          if (!open && !busy) setMoveItems(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("移动到…")}</DialogTitle>
            <DialogDescription>
              {t("选择目标文件夹，画板内容保持不变。")}
            </DialogDescription>
          </DialogHeader>
          <select
            aria-label={t("目标文件夹")}
            size={10}
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={destination ?? ""}
            onChange={(event) => setDestination(event.target.value || null)}
          >
            <option value="">{t("画板库")}</option>
            {destinationFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderAncestors(library!, f.id)
                  .map((a) => a.name)
                  .join(" / ")}
              </option>
            ))}
          </select>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setMoveItems(null)}
            >
              {t("取消")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => moveItems && void move(moveItems, destination)}
            >
              {t("移动")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(deleteItems)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteItems(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("删除所选项目")}</DialogTitle>
            <DialogDescription>
              {t("所选画板及文件夹内的画板将移入回收站，文件夹目录会被移除。")}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{deleteItems?.map(nameOf).join("、")}</p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteItems(null)}
            >
              {t("取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {t("移入回收站")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DropdownMenu
        open={Boolean(context)}
        onOpenChange={(open) => {
          if (!open) setContext(null);
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            style={{
              position: "fixed",
              left: context?.x ?? -10,
              top: context?.y ?? -10,
              width: 1,
              height: 1,
              pointerEvents: "none",
            }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={0}
          onCloseAutoFocus={(event) => { event.preventDefault(); if (!contextRef.current && !dialogOpenRef.current) managerRef.current?.focus({ preventScroll: true }); }}
        >
          {context && menuEntries(context.items, context.parentId)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
