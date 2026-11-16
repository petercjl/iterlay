import { setTimeout as delay } from "node:timers/promises";
import type { AgentTool } from "./agents/tool-runtime.js";
import type { TSchema } from "typebox";
import { callLocalApi } from "./local-api-client.js";
import { buildToolContent, listWorkspaceTools } from "./workspace-tools.js";

type JsonObject = Record<string, unknown>;
type LocalApiCall = (
  userDataPath: string,
  method: string,
  args: Record<string, unknown>
) => Promise<unknown>;

const BOARD_WRITE_TOOLS = new Set([
  "create_canvas",
  "update_canvas",
  "move_image",
  "resize_image",
  "arrange_images",
  "duplicate_images",
  "trash_images",
  "set_image_version",
  "generate_image",
  "edit_image",
  "generate_video",
  "import_image",
  "import_video"
]);

const SEQUENTIAL_TOOLS = new Set([
  ...BOARD_WRITE_TOOLS,
  "restore_image",
  "create_board",
  "open_board",
  "fit_board_view",
  "focus_nodes",
  "stop_video_polling",
  "export_assets",
  "open_tuda"
]);

export interface TudaAgentToolOptions {
  boardId?: string;
  conversationId?: string;
  preserveView?: boolean;
  referenceImagePaths?: string[];
  referenceNodeIds?: string[];
}

export function createTudaAgentTools(
  userDataPath: string,
  options: TudaAgentToolOptions = {},
  callBridge: LocalApiCall = callLocalApi
): AgentTool[] {
  return listWorkspaceTools().map((definition) => {
    const name = stringValue(definition.name);
    const description = stringValue(definition.description);
    const inputSchema = isRecord(definition.inputSchema)
      ? definition.inputSchema
      : { type: "object", properties: {} };
    return {
      name,
      label: toolLabel(name),
      description,
      parameters: inputSchema as TSchema,
      executionMode: SEQUENTIAL_TOOLS.has(name) ? "sequential" : "parallel",
      execute: async (_toolCallId, rawArgs, signal) => {
        let args = isRecord(rawArgs) ? rawArgs : {};
        if (name === "generate_video" && args.textOnly !== true && !args.firstFramePath && !args.lastFramePath
          && !(Array.isArray(args.referenceImagePaths) && args.referenceImagePaths.length)) {
          args = { ...args,
            ...(options.referenceImagePaths?.length ? { referenceImagePaths: options.referenceImagePaths } : {}),
            ...(options.referenceNodeIds?.length ? { referenceNodeIds: options.referenceNodeIds } : {}) };
        }
        if (["generate_image", "edit_image"].includes(name) && options.conversationId) args = {...args, assistantConversationId: options.conversationId};
        assertBoardScope(name, args, options.boardId);
        const call = () => callBridge(userDataPath, name, options.preserveView ? { ...args, preserveView: true } : args);
        let result = await call();
        // Wait within one tool invocation instead of spending a Pi turn on each poll.
        const deadline = Date.now() + 30_000;
        while (name === "get_generation_status" && isRecord(result) && ["running", "queued"].includes(String(result.status)) && Date.now() < deadline) {
          await delay(1500, undefined, {signal});
          result = await call();
        }
        return {
          content: buildToolContent(result),
          details: { toolName: name }
        };
      }
    } satisfies AgentTool;
  });
}

function assertBoardScope(name: string, args: JsonObject, boardId?: string): void {
  if (!boardId || !BOARD_WRITE_TOOLS.has(name)) return;
  if (args.boardId !== boardId) {
    throw new Error(`工具 ${name} 只能操作当前画板 ${boardId}。`);
  }
}

function toolLabel(name: string): string {
  return name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Tuda 工作台 工具定义无效。");
  return value.trim();
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
