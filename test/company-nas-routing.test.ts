import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { AssetStore } from "../electron/storage/asset-store.js";
import type { SettingsStore } from "../electron/storage/settings-store.js";
import type { EnterpriseClient } from "../electron/enterprise/client.js";
const hooks = vi.hoisted(() => ({ router: undefined as undefined | ((event: never, channel: string, args: unknown[], next: () => unknown) => unknown) }));
vi.mock("electron", () => ({
  app: {}, shell: {}, ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() }
}));
vi.mock("../electron/renderer-security.js", () => ({ setCommandRouter: (router: typeof hooks.router) => { hooks.router = router; return () => { hooks.router = undefined; }; } }));
import { CompanyDesktop } from "../electron/company/desktop.js";
import { registerEnterprise } from "../electron/enterprise/integration.js";
import { inExecutionSpace } from "../electron/execution-space.js";
import { BoardStore as LocalBoardStore } from "../electron/storage/board-store.js";
import { TemplateStore } from "../electron/storage/template-store.js";

it("reads assistant context from the authorized NAS board and scoped auxiliary stores without allowing unsupported mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-nas-context-"));
  const command = vi.fn();
  const legacy = Object.assign(new EventEmitter(), { status: { pendingWrites: 0 }, stop: vi.fn(), command, ownsBoard: () => false }) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, { accountOrigin: "https://company.example", nasUrl: "https://nas.example" });
  let dispose: (() => void) | undefined;
  try {
    await company.initialize();
    await company.account.restore({ origin: company.account.origin, session: {
      contract: 1, appId: "tuda", sessionId: "device", token: "fixture-token", expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      member: { id: "employee", name: "员工" }, organization: { id: "org", name: "公司" }
    } });
    const personal = new LocalBoardStore(path.join(root, "personal"));
    const board = await personal.createBoard("NAS board fixture");
    command.mockResolvedValue({ ...board, revision: 12 });
    const localRead = vi.spyOn(personal, "getComicDramaBoardSnapshot");
    const boards = company.nasBoards(personal);
    await inExecutionSpace(async () => {
      expect(await boards.getComicDramaBoardSnapshot(board.id)).toEqual({ boardId: board.id, revision: 12, nodes: [], connections: [], groups: [] });
      expect(command).toHaveBeenCalledWith("boards:get", [board.id]);
      expect(localRead).not.toHaveBeenCalled();
      command.mockResolvedValueOnce(null);
      await expect(boards.getComicDramaBoardSnapshot("missing")).rejects.toThrow("画板不存在");
      command.mockRejectedValueOnce(new Error("NAS read denied"));
      await expect(boards.getComicDramaBoardSnapshot(board.id)).rejects.toThrow("NAS read denied");
    }, "enterprise");
    const personalTemplates = new TemplateStore(path.join(root, "templates.json"));
    await personalTemplates.create({ name: "Private template", prompt: "Personal instructions" });
    const templates = company.scopeStore(personalTemplates, workspace => new TemplateStore(path.join(workspace, "templates.json")));
    expect(await inExecutionSpace(() => templates.list(), "enterprise")).toEqual([]);
    expect(await inExecutionSpace(() => templates.list(), "personal")).toHaveLength(1);
    dispose = registerEnterprise(legacy, boards, {} as AssetStore, {} as SettingsStore, company);
    await inExecutionSpace(async () => {
      for (const channel of ["comicDrama:getBoardSnapshot", "video:list", "video:recover", "comments:list", "sceneMedia:list", "templates:list", "templates:get"]) {
        const next = vi.fn().mockResolvedValue("scoped-result");
        expect(await hooks.router!(undefined as never, channel, [], next)).toBe("scoped-result");
        expect(next).toHaveBeenCalledOnce();
      }
      const next = vi.fn();
      await expect(hooks.router!(undefined as never, "comicDrama:applyMutationPlan", [], next)).rejects.toThrow("未写入个人空间");
      expect(next).not.toHaveBeenCalled();
    }, "enterprise");
  } finally { dispose?.(); company.stop(); await rm(root, { recursive: true, force: true }); }
});
