import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const mocks = vi.hoisted(() => ({ getSettings: vi.fn(async () => ({ activeProviderId: "" })), listBoards: vi.fn(async () => []), enterpriseStatus: vi.fn(async () => ({ authenticated: true, activeSpace: "enterprise" })) }));
vi.mock("../electron/application/workbench-api.js", () => ({ createMainWorkbenchApi: () => mocks }));
vi.mock("../electron/window-lifecycle.js", () => ({ flushWindow: async () => undefined }));
import { startLocalApi } from "../electron/local-api.js";

it("enforces the server capability boundary, private auth and per-call company validation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-plugin-api-"));
  const grant = vi.fn(async () => ({ authenticated: true }));
  const authorize = vi.fn(async () => undefined);
  const quit = vi.fn(async () => undefined);
  vi.stubEnv("TUDA_PLUGIN_SPACE", "enterprise");
  const dispose = await startLocalApi({ isDestroyed: () => false, webContents: {} } as never, directory, () => undefined, grant, authorize, quit);
  const info = JSON.parse(await readFile(path.join(directory, "local-api.json"), "utf8"));
  const call = async (route: string, body: unknown, token = info.token) => fetch(`http://127.0.0.1:${info.port}${route}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
  });
  try {
    expect((await call("/board-plugin/call", { method: "list_boards", args: {} }, "wrong")).status).toBe(401);
    expect((await call("/board-plugin/call", { method: "generate_image", args: {} })).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
    expect((await call("/board-plugin/call", { method: "list_boards", args: { space: "personal" } })).status).toBe(400);
    expect((await call("/board-plugin/auth", { contract: 1, code: "private" })).status).toBe(200);
    expect(grant).toHaveBeenCalledWith({ contract: 1, code: "private" });
    expect((await call("/board-plugin/host/quit", {})).status).toBe(400);
    expect(quit).not.toHaveBeenCalled();
    vi.stubEnv("TUDA_EMBEDDED_HOST", "codex-own");
    expect((await call("/board-plugin/host/quit", {})).status).toBe(200);
    expect(quit).toHaveBeenCalledOnce();
    expect((await call("/board-plugin/call", { method: "list_boards", args: {} })).status).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    mocks.listBoards.mockClear();
    authorize.mockRejectedValue(new Error("PARENT_SESSION_REVOKED"));
    expect((await call("/board-plugin/call", { method: "list_boards", args: {} })).status).toBe(400);
    expect(mocks.listBoards).not.toHaveBeenCalled();
  } finally { dispose(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); }
});
