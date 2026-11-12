import { listWorkspaceTools } from "./workspace-tools.js";

/** Explicit capability boundary shared by discovery and backend dispatch. */
const existing = new Set([
  "status", "get_space", "get_board_library", "manage_board_library", "list_boards", "get_active_board",
  "get_board", "get_board_layout", "open_board", "fit_board_view", "focus_nodes", "move_image",
  "resize_image", "arrange_images", "duplicate_images", "trash_images", "restore_image",
  "list_assets", "read_asset", "export_assets", "open_tuda"
]);
const str = { type: "string", minLength: 1 };
const num = { type: "number" };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { name, description, inputSchema: { type: "object", properties: {
    space: { type: "string", enum: ["personal", "enterprise"] }, ...properties
  }, required, additionalProperties: false } };
}
export function boardPluginTools() {
  return [
    ...listWorkspaceTools().filter(t => existing.has(String(t.name))).map(t => {
      if (!["open_tuda", "open_board", "fit_board_view", "focus_nodes"].includes(String(t.name))) return t;
      const schema = t.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      return { ...t, name: t.name,
        description: String(t.description) + " Foreground-only operation: call ONLY when the user explicitly asks to open/view/focus Tuda. Never use for imports, automatic visual QA, reconnecting, or task completion. Ordinary board tools work silently without opening a board.",
        inputSchema: { ...schema, properties: { ...schema.properties,
          userRequestedView: { type: "boolean", const: true, description: "Set true only for an explicit user request to display Tuda. Never infer permission from an import/edit task." }
        }, required: [...(schema.required ?? []), "userRequestedView"] }
      };
    }),
    tool("create_board", "Create an empty Tuda board. Does not generate media.", { name: str }, ["name"]),
    tool("rename_board", "Rename an existing board.", { boardId: str, name: str }, ["boardId", "name"]),
    tool("trash_board", "Move a board to the recoverable trash. Follow the user's deletion authorization.", { boardId: str }, ["boardId"]),
    tool("list_trashed_boards", "List recoverable boards.", {}, []),
    tool("restore_board", "Restore a board from trash.", { boardId: str }, ["boardId"]),
    tool("import_board_images", "Copy existing local image files into Tuda and place them as one batch. No model calls. Stable operationId makes retries safe. Existing nodes stay in place.", {
      boardId: str, operationId: str,
      files: { type: "array", minItems: 1, maxItems: 30, items: str },
      columns: { type: "integer", minimum: 1, maximum: 30 }, gap: { type: "number", minimum: 0, maximum: 1000 },
      displayWidth: { type: "number", minimum: 120, maximum: 1200 },
      x: num, y: num, anchorNodeId: str, side: { type: "string", enum: ["right", "below"] }
    }, ["boardId", "operationId", "files"]),
    tool("write_board_text", "Create an editable text note or update a text node after reading it. No generation. Relative placement is a one-time layout, not an automatic attachment.", {
      boardId: str, operationId: str, text: { type: "string", maxLength: 100000 }, title: { type: "string" },
      nodeId: str, expectedText: { type: "string" }, x: num, y: num, anchorNodeId: str,
      side: { type: "string", enum: ["right", "below"] }, displayWidth: { type: "number", minimum: 120, maximum: 1200 }
    }, ["boardId", "operationId", "text"]),
    tool("move_board_nodes", "Move existing image/text nodes to explicit coordinates. Read the board first and supply its revision; locked nodes are preserved.", {
      boardId: str, expectedRevision: { type: "integer", minimum: 0 },
      positions: { type: "array", minItems: 1, maxItems: 1000, items: { type: "object", properties: { nodeId: str, x: num, y: num }, required: ["nodeId", "x", "y"], additionalProperties: false } }
    }, ["boardId", "expectedRevision", "positions"])
  ];
}
export function assertBoardPluginMethod(method: string) {
  if (!boardPluginTools().some(tool => tool.name === method)) throw new Error("PLUGIN_CAPABILITY_DENIED: operation is outside the board plugin profile");
}
