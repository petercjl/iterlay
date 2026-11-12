#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { boardPluginTools, assertBoardPluginMethod } from "../../electron/board-plugin-tools.js";
import { connect, desktopInstance } from "./runtime.js";
import { defaultUserDataPath } from "./paths.js";
import { assertInlineMediaByteLength } from "../../shared/media-import.js";

const userData = process.env.TUDA_USER_DATA_PATH || defaultUserDataPath();
const fixedSpace = process.env.TUDA_SPACE || process.env.TUDA_PLUGIN_SPACE;
if (fixedSpace && !["personal", "enterprise"].includes(fixedSpace)) throw new Error("INVALID_SPACE");
let authenticatedInstance: string | undefined;
let authenticatedGrant: string | undefined;
const connectionSecret = process.env.TUDA_AUTH_HANDOFF_FILE ? randomBytes(32).toString("hex") : undefined;
async function local(route: string, payload: unknown): Promise<unknown> {
  let info: { port: number; token: string };
  try { info = JSON.parse(await readFile(path.join(userData, "local-api.json"), "utf8")); } catch { throw new Error("INVALID_LOCAL_BRIDGE"); }
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(info.token)) throw new Error("INVALID_LOCAL_BRIDGE");
  const response = await fetch(`http://127.0.0.1:${info.port}${route}`, { method: "POST",
    headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json", ...(connectionSecret ? {"x-tuda-plugin-session": connectionSecret} : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) });
  const result = await response.json() as { result?: unknown; error?: string };
  if (!response.ok) throw new Error(result.error || (route === "/board-plugin/auth" ? "AUTH_HANDOFF_FAILED" : "BOARD_PLUGIN_FAILED"));
  return result.result;
}
async function ready() {
  await connect({ userDataPath: userData, appRoot: process.env.TUDA_APP_PATH, noLaunch: process.env.TUDA_NO_LAUNCH === "1", startupTimeoutMs: Number(process.env.TUDA_STARTUP_TIMEOUT_MS ?? 120000) });
  const instanceId = await desktopInstance(userData);
  if (process.env.TUDA_AUTH_HANDOFF_FILE) {
    const file = process.env.TUDA_AUTH_HANDOFF_FILE;
    if (!path.isAbsolute(file)) throw new Error("UNSAFE_AUTH_HANDOFF_FILE");
    const info = await stat(file).catch(() => { throw new Error("AUTH_HANDOFF_REQUIRED"); });
    if (!path.isAbsolute(file) || !info.isFile() || info.size > 16384 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("UNSAFE_AUTH_HANDOFF_FILE");
    const bytes = await readFile(file, "utf8"), digest = createHash("sha256").update(bytes).digest("hex");
    if (authenticatedInstance === instanceId && authenticatedGrant === digest) return;
    let grant: unknown;
    try { grant = JSON.parse(bytes); } catch { throw new Error("INVALID_AUTH_HANDOFF_FILE"); }
    if (!grant || typeof grant !== "object" || (grant as { instanceId?: string }).instanceId !== instanceId) throw new Error("AUTH_HANDOFF_STALE_INSTANCE");
    await local("/board-plugin/auth", grant);
    authenticatedInstance = instanceId;
    authenticatedGrant = digest;
  }
}
export async function importLocalFiles(args: Record<string, unknown>) {
  if (!Array.isArray(args.files) || !args.files.length || args.files.length > 30) throw new Error("INVALID_FILES");
  const images: string[] = [];
  let total = 0;
  for (const file of args.files) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("ABSOLUTE_LOCAL_IMAGE_REQUIRED");
    const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[path.extname(file).toLowerCase()];
    if (!mime) throw new Error("UNSUPPORTED_LOCAL_IMAGE");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("LOCAL_IMAGE_REQUIRED");
    assertInlineMediaByteLength(info.size, "local image");
    const bytes = await readFile(file);
    assertInlineMediaByteLength(bytes.length, "local image");
    total += bytes.length;
    if (total > 20 * 1024 * 1024) throw new Error("BATCH_TOO_LARGE: maximum combined image bytes is 20 MiB");
    images.push(`data:${mime};base64,${bytes.toString("base64")}`);
  }
  const rest = { ...args };
  delete rest.files;
  return { ...rest, images };
}
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const server = new Server({ name: "tuda-board", version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: boardPluginTools() as never }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    assertBoardPluginMethod(request.params.name);
    let args = request.params.arguments ?? {};
    if (["open_tuda", "open_board", "fit_board_view", "focus_nodes"].includes(request.params.name) && args.userRequestedView !== true) {
      throw new Error("EXPLICIT_VIEW_INTENT_REQUIRED: Only open or focus Tuda when the user explicitly asks to view it; pass userRequestedView=true. Importing, editing, verifying and reconnecting stay silent.");
    }
    if (fixedSpace) {
      if (args.space && args.space !== fixedSpace) throw new Error("SPACE_MISMATCH");
      args = { ...args, space: fixedSpace };
    }
    if (request.params.name === "import_board_images") args = await importLocalFiles(args);
    await ready();
    const result = await local("/board-plugin/call", { method: request.params.name, args });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    // Auth errors are already sanitized. Never expose a handoff payload or local bearer.
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "BOARD_PLUGIN_FAILED" }] };
  }
});
await server.connect(new StdioServerTransport());
