import { isBoardImageNode, type BoardDetail, type BoardNode, type BoardSavePayload } from "@shared/types";
import { rebaseBoardSnapshot } from "@shared/board-snapshot-merge";
import { hydrateGeneratedImage, serializeGeneratedImage } from "@/lib/board-node-image";
import type { GeneratedImage } from "@/components/canvas/image-node-model";
import type { CanvasNodeLayout } from "@/components/canvas/canvas-history";

/** Retain edits made while saving, and incorporate previously unseen remote nodes. */
export function reconcileBoardSave(
  saved: BoardDetail, submitted: BoardSavePayload,
  current: { images: GeneratedImage[]; workflowNodes: BoardNode[]; positions: Record<string, CanvasNodeLayout> }
) {
  const imageById = new Map(current.images.map((image) => [image.id, image]));
  const urls = { ...saved.images };
  for (const image of current.images) {
    if (image.path) urls[image.path] = image.dataUrl;
    for (const version of image.versions ?? []) urls[version.path] = version.dataUrl;
  }
  const localNodes: BoardNode[] = [
    ...current.images.filter((image) => !image.pending && image.path).map((image) => serializeGeneratedImage(image, current.positions[image.id] ?? { x: 0, y: 0 })),
    ...current.workflowNodes.map((node) => ({ ...node, x: current.positions[node.id]?.x ?? node.x, y: current.positions[node.id]?.y ?? node.y }))
  ];
  const rebased = rebaseBoardSnapshot(
    { ...saved, nodes: submitted.nodes ?? [], connections: submitted.connections },
    { ...submitted, nodes: localNodes }, saved
  );
  const nodes = rebased.nodes ?? [];
  const images = nodes.filter(isBoardImageNode).flatMap((node) => {
    const hydrated = hydrateGeneratedImage(node, urls);
    if (!hydrated) return [];
    const previous = imageById.get(node.id);
    // Old NAS nodes may omit intrinsic dimensions. Preserve decoded metadata only
    // for the same media version; another version must resolve its own size.
    const dimensions = previous?.path === hydrated.path && (!hydrated.width || !hydrated.height)
      ? {width: previous.width, height: previous.height} : {};
    return [{...previous, ...hydrated, ...dimensions}];
  });
  return {
    images: [...images, ...current.images.filter((image) => image.pending)],
    workflowNodes: nodes.filter((node) => !isBoardImageNode(node)),
    positions: Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y, width: node.displayWidth, height: node.displayHeight }])),
    connections: rebased.connections ?? []
  };
}
