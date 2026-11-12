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
  type BoardFolder,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BoardLibrary, type BoardLibraryProps } from "./BoardLibrary";
import { useEnterpriseStatus } from "@/components/enterprise/use-enterprise";

interface Props extends Omit<
  BoardLibraryProps,
  "onCreateBoard" | "onImportBoard" | "onImportBoardFiles"
> {
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
  const { onInteractionLockChange } = props;
  const [library, setLibrary] = useState<BoardLibraryState | null>(null);
  const [error, setError] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryItem[]>([]);
  const [cut, setCut] = useState<LibraryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [childLocked, setChildLocked] = useState(false);
  const [nameDialog, setNameDialog] = useState<{
    id?: string;
    kind: "folder" | "board";
    name: string;
  } | null>(null);
  const [moveItems, setMoveItems] = useState<LibraryItem[] | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [deleteFolder, setDeleteFolder] = useState<BoardFolder | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const request = useRef(0);
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
    } catch { /* Standalone previews have no desktop bridge; reload shows its connection error. */ }
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
  const modal = Boolean(nameDialog || moveItems || deleteFolder);
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
  return (
    <div
      className="h-full min-h-0"
      data-board-file-manager
      onDragEnd={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (
          (event.target as HTMLElement).closest(
            "input,textarea,select,[contenteditable=true]",
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
        }
        if (
          command &&
          event.key.toLowerCase() === "v" &&
          cut.length &&
          !readOnly
        ) {
          event.preventDefault();
          void move(cut, current);
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
            <button
              type="button"
              disabled={locked || modal}
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
                    onClick={() => setCut(selected)}
                  >
                    <Scissors className="mr-1 h-3.5 w-3.5" />
                    {t("剪切")}
                  </Button>
                </>
              )}
              {cut.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={locked || readOnly}
                    onClick={() => void move(cut, current)}
                  >
                    <ClipboardPaste className="mr-1 h-3.5 w-3.5" />
                    {t("粘贴 {{ui:0}} 项", [cut.length])}
                  </Button>
                  <button onClick={() => setCut([])}>{t("取消剪切")}</button>
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
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 shrink-0"
                            aria-label={t("文件夹 {{ui:0}} 操作", [
                              folder.name,
                            ])}
                            disabled={locked || readOnly}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem
                            onSelect={() =>
                              setNameDialog({
                                id: folder.id,
                                kind: "folder",
                                name: folder.name,
                              })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                            {t("重命名")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setMoveItems([{ kind: "folder", id: folder.id }]);
                              setDestination(current);
                            }}
                          >
                            <FolderInput className="h-4 w-4" />
                            {t("移动到…")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDeleteFolder(folder)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t("删除空文件夹")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                      parentId: current,
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
        open={Boolean(deleteFolder)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteFolder(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("删除空文件夹")}</DialogTitle>
            <DialogDescription>
              {t("仅删除空文件夹。含画板或子文件夹时，请先将内容移出。")}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{deleteFolder?.name}</p>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteFolder(null)}
            >
              {t("取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (deleteFolder)
                  void mutate({
                    type: "deleteEmptyFolder",
                    id: deleteFolder.id,
                  }).then((ok) => {
                    if (ok) setDeleteFolder(null);
                  });
              }}
            >
              {t("删除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
