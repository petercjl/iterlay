import { expect, it, vi } from "vitest";
import { CompanyAccount } from "../electron/company/account.js";
const origin = "https://company.example.test";
const session = { contract: 1, appId: "tuda", sessionId: "derived", token: "private-derived-token", expiresAt: new Date(Date.now() + 3600000).toISOString(), member: { id: "m", name: "员工" }, organization: { id: "o", name: "组织" } };
const handoff = () => ({ contract: 1, appId: "tuda", origin, code: "c".repeat(43), verifier: "v".repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() });
function fixture(badBootstrap = false) {
  const persist = vi.fn(async () => undefined);
  const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
    const route = String(url);
    if (route.endsWith("/handoff/exchange")) {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(new Headers(init?.headers).get("x-company-app-id")).toBe("tuda");
      return Response.json({ ok: true, data: { ...session, status: "authorized" } });
    }
    if (route.endsWith("/session")) return Response.json({ ok: true, data: { ...session, authenticated: true } });
    return Response.json({ ok: true, data: { contract: 1, appId: "tuda", sessionId: badBootstrap ? "other" : session.sessionId,
      member: session.member, organization: session.organization, configVersion: "1", text: { enabled: false, defaultModel: null, providers: [] },
      image: { enabled: false, models: [] }, storage: { enabled: false } } });
  });
  return { account: new CompanyAccount(origin, persist, fetcher as typeof fetch), persist, fetcher };
}
it("exchanges PKCE only for the trusted Tuda audience, persists its own session and returns no secrets", async () => {
  const f = fixture();
  const result = await f.account.acceptHostHandoff(handoff());
  expect(result).toEqual({ authenticated: true, memberId: "m", organizationId: "o" });
  expect(JSON.stringify(result)).not.toContain(session.token);
  expect(JSON.stringify(f.account.status)).not.toContain(session.token);
  expect(f.persist).toHaveBeenCalled();
});
it("rejects wrong app, untrusted origin, expired and malformed handoffs before any network access", async () => {
  const f = fixture();
  for (const change of [{ appId: "codex-own" }, { origin: "https://evil.test" }, { code: "bad" }, { expiresAt: new Date(0).toISOString() }]) {
    await expect(f.account.acceptHostHandoff({ ...handoff(), ...change })).rejects.toThrow("AUTH_HANDOFF_INVALID");
  }
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("rolls back a failed bootstrap and sanitizes auth errors", async () => {
  const f = fixture(true);
  await expect(f.account.acceptHostHandoff(handoff())).rejects.toThrow("AUTH_HANDOFF_FAILED");
  expect(f.account.authenticated).toBe(false);
  expect(f.persist).toHaveBeenLastCalledWith({ origin });
});
