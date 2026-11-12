import type { BoardDetail, BoardSummary } from "@shared/types";
import type { ImageWorkbenchApi } from "@shared/workbench-client";
import { resolveBoardCover } from "@shared/board-cover";

export function encodeCoverThumbnail(url: string): Promise<string> {
  return new Promise(resolve => {
    const image = new Image();
    const finish = (value: string) => { clearTimeout(timer); image.onload = null; image.onerror = null; resolve(value); };
    const timer = setTimeout(() => finish(""), 8000);
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish("");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", 0.75));
      } catch { finish(""); }
    };
    image.onerror = () => finish("");
    image.src = url;
  });
}

export function coverForDetail(board: BoardDetail, force = false) {
  return resolveBoardCover(board, path => encodeCoverThumbnail(board.images[path] ?? ""), force);
}

/** Revision checks protect concurrent image changes and manual cover choices. */
export async function saveBoardCover(api: ImageWorkbenchApi, id: string, nodeId?: string, force = false): Promise<BoardSummary | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const board = await api.getBoard(id);
    if (!board) throw new Error("画板不存在。");
    if (nodeId && !board.nodes.some(node => node.id === nodeId && (node.type === "image" || !node.type))) throw new Error("封面图片已被移除。");
    const cover = await coverForDetail({ ...board, coverNodeId: nodeId ?? board.coverNodeId }, force || nodeId !== undefined);
    if (nodeId && !cover.thumbnailDataUrl) throw new Error("图片暂时无法读取，请重试或选择其他图片。");
    if (nodeId === undefined && !cover.thumbnailDataUrl) return null;
    try { return await api.saveBoard({ id, expectedRevision: board.revision ?? 0, ...cover }); }
    catch (error) {
      if (attempt === 2 || !(error instanceof Error) || !error.message.includes("BOARD_REVISION_CONFLICT")) throw error;
    }
  }
  return null;
}
