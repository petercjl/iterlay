import { createHash } from "node:crypto";
import { inExecutionContext } from "../execution-space.js";
import type { CompanyDesktop } from "./desktop.js";

export const BOARD_PLUGIN_SESSION_CONTRACT = { contract: 1, authScope: "connection", preservesDesktopSession: true } as const;
/** Private connection capabilities live only in the main process, never renderer state. */
export class BoardPluginSessions {
  private sessions = new Map<string, { company: CompanyDesktop; touched: number }>();
  constructor(private create: (grant: unknown, connectionKey: string) => Promise<CompanyDesktop>) {}
  private key(secret: unknown) {
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("PLUGIN_CONNECTION_REQUIRED");
    return createHash("sha256").update(secret).digest("hex");
  }
  async accept(secret: unknown, grant: unknown) {
    const key = this.key(secret);
    for (const [id, value] of this.sessions) if (Date.now() - value.touched > 86400000 || !value.company.account.authenticated) {
      value.company.stop(); value.company.legacy.stop(); this.sessions.delete(id);
    }
    if (!this.sessions.has(key) && this.sessions.size >= 64) throw new Error("PLUGIN_CONNECTION_LIMIT");
    const company = await this.create(grant, key), previous = this.sessions.get(key);
    this.sessions.set(key, { company, touched: Date.now() });
    if (previous) { previous.company.stop(); previous.company.legacy.stop(); }
    return { authenticated: true, space: "enterprise", ...BOARD_PLUGIN_SESSION_CONTRACT };
  }
  async run<T>(secret: unknown, work: () => Promise<T>): Promise<T> {
    const entry = this.sessions.get(this.key(secret));
    if (!entry) throw new Error("AUTH_HANDOFF_REQUIRED");
    return inExecutionContext({ space: "enterprise", account: entry.company.namespace, workspace: entry.company.workspace,
      storage: entry.company.storage, pluginCompany: entry.company }, async () => {
      await entry.company.authorizeHostOperation();
      entry.touched = Date.now();
      return work();
    });
  }
  stop() { for (const entry of this.sessions.values()) { entry.company.stop(); entry.company.legacy.stop(); } this.sessions.clear(); }
}
