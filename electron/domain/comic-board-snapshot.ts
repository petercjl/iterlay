import type { BoardData, ComicDramaBoardSnapshot } from "../../shared/types.js";
import { isManagedBoardNode } from "./board-model.js";

/** Use the same assistant view for local boards and authorized NAS board reads. */
export function comicBoardSnapshot(board: BoardData): ComicDramaBoardSnapshot {
  const managedIds = new Set(board.nodes.filter(isManagedBoardNode).map(node => node.id));
  return {
    boardId: board.id,
    revision: board.revision ?? 0,
    nodes: structuredClone(board.nodes.filter(isManagedBoardNode)),
    connections: structuredClone((board.connections ?? []).filter(connection =>
      connection.kind === "reference" && (managedIds.has(connection.source) || managedIds.has(connection.target)))),
    groups: structuredClone(board.groups ?? [])
  };
}
