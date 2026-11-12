import { useEffect, useRef } from "react";
import { useReactFlow, ViewportPortal, useNodes } from "@xyflow/react";
import { getImageWorkbenchApi } from "@/lib/image-workbench-api";
import { useEnterpriseStatus } from "./use-enterprise";

const colors = ["#0755f5", "#00a78d", "#ad43d4", "#d77517", "#d8406a"];
export function CollaborationOverlay() {
  const status = useEnterpriseStatus();
  const { screenToFlowPosition } = useReactFlow();
  const nodes = useNodes();
  const lastSent = useRef(0);
  const selected = useRef<string[]>([]);
  selected.current = nodes.filter(node => node.selected).map(node => node.id);
  useEffect(() => {
    if (status?.activeSpace !== "enterprise" || !status.authenticated) return;
    const move = (event: PointerEvent) => {
      if (Date.now() - lastSent.current < 90 || !(event.target instanceof Element) || !event.target.closest(".react-flow")) return;
      lastSent.current = Date.now();
      void getImageWorkbenchApi().enterprisePresence({ cursor: screenToFlowPosition({ x: event.clientX, y: event.clientY }), selectedNodeIds: selected.current }).catch(() => undefined);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [screenToFlowPosition, status?.activeSpace, status?.authenticated]);
  if (!status || status.activeSpace !== "enterprise") return null;
  return <ViewportPortal><div className="pointer-events-none" aria-hidden="true">{status.peers.filter(peer => peer.cursor).map((peer, index) => {
    const color = colors[index % colors.length];
    return <div key={peer.connectionId} data-peer-cursor={peer.id} className="absolute left-0 top-0" style={{ transform: `translate(${peer.cursor!.x}px, ${peer.cursor!.y}px)`, color, zIndex: 10000 }}>
      <svg width="18" height="23" viewBox="0 0 18 23"><path d="M1 1L16 13L9 14L6 21Z" fill="currentColor" stroke="white" strokeWidth="1.5" /></svg>
      <span className="absolute left-4 top-4 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-white shadow" style={{ background: color }}>{peer.name}{peer.selectedNodeIds?.length ? ` · 选中 ${peer.selectedNodeIds.length} 项` : ""}</span>
    </div>;
  })}</div></ViewportPortal>;
}
