import { useEffect, useState } from "react";
import { isBoardImageNode, type BoardDetail, type BoardSummary } from "@shared/types";
import { useUiText } from "@/i18n";
import { getImageWorkbenchApi } from "@/lib/image-workbench-api";
import { saveBoardCover } from "@/lib/board-cover";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function BoardCoverDialog({ boardId, onClose, onSaved }: {
  boardId: string; onClose: () => void; onSaved: (board: BoardSummary) => Promise<void>;
}) {
  const t = useUiText();
  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void getImageWorkbenchApi().getBoard(boardId).then(value => {
      if (!alive) return;
      if (!value) throw new Error("画板不存在。");
      setBoard(value); setSelected(value.coverNodeId ?? "");
    }).catch(error => { if (alive) setError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [boardId]);
  async function save(nodeId: string) {
    setBusy(true); setError("");
    try {
      const summary = await saveBoardCover(getImageWorkbenchApi(), boardId, nodeId);
      if (summary) await onSaved(summary);
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const images = board?.nodes.filter(isBoardImageNode) ?? [];
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-2xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{t("更换封面")}</DialogTitle>
        <DialogDescription>{t("从画板中选择一张图片作为封面，或恢复自动选择。")}</DialogDescription></DialogHeader>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {!board && !error ? <p>{t("正在加载…")}</p> : null}
      {board && !images.length ? <p>{t("画板中暂无图片")}</p> : null}
      <div className="grid max-h-[50vh] grid-cols-3 gap-3 overflow-y-auto p-1">
        {images.map((node, index) => <button key={node.id} type="button" disabled={busy} aria-label={t("选择图片 {{ui:0}}", [index + 1])} aria-pressed={selected === node.id}
          className={`overflow-hidden rounded-lg border-2 p-1 focus-visible:outline focus-visible:outline-2 ${selected === node.id ? "border-primary" : "border-transparent"}`}
          onClick={() => setSelected(node.id)}>
          <img src={board?.images[node.imagePath]} alt={t("图片 {{ui:0}}", [index + 1])} className="h-28 w-full rounded object-contain bg-muted" />
          <span className="text-xs">{t("图片 {{ui:0}}", [index + 1])}{board?.coverNodeId === node.id ? ` · ${t("当前封面")}` : ""}</span>
        </button>)}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={!board || busy} onClick={() => void save("")}>{t("恢复自动选择")}</Button>
        <Button variant="outline" disabled={busy} onClick={onClose}>{t("取消")}</Button>
        <Button disabled={!selected || busy || !board} onClick={() => void save(selected)}>{t(busy ? "正在保存…" : "设为画板封面")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
