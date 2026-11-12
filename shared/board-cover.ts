import { isBoardImageNode, type BoardData, type BoardNodeSnapshot } from "./types.js";

export function boardCoverCandidates(board: Pick<BoardData, "nodes" | "coverNodeId">): BoardNodeSnapshot[] {
  const images = board.nodes.filter(isBoardImageNode).filter(node => node.imagePath);
  const chosen = images.find(node => node.id === board.coverNodeId);
  return chosen ? [chosen] : images;
}

/** Failed encodes remain retryable; automatic mode tries the next readable image. */
export async function resolveBoardCover(
  board: Pick<BoardData, "nodes" | "coverNodeId" | "thumbnailDataUrl" | "thumbnailImagePath">,
  encode: (path: string) => Promise<string>, force = false
): Promise<{ coverNodeId: string; thumbnailDataUrl: string; thumbnailImagePath: string }> {
  const candidates = boardCoverCandidates(board);
  const coverNodeId = candidates.some(node => node.id === board.coverNodeId) ? board.coverNodeId! : "";
  for (const node of candidates) {
    if (!force && board.thumbnailDataUrl && board.thumbnailImagePath === node.imagePath)
      return { coverNodeId, thumbnailDataUrl: board.thumbnailDataUrl, thumbnailImagePath: node.imagePath };
    try {
      const data = await encode(node.imagePath);
      if (data) return { coverNodeId, thumbnailDataUrl: data, thumbnailImagePath: node.imagePath };
    } catch { /* An unavailable image must not prevent saving the board. */ }
  }
  return { coverNodeId, thumbnailDataUrl: "", thumbnailImagePath: "" };
}
