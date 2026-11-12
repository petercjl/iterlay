import { expect, it } from "vitest";
import {
  CompanyStorageAuth,
  commandStorageScopes,
  requireStorageScope,
} from "../enterprise/src/company-auth.js";
import { readConfig } from "../enterprise/src/config.js";
const config = readConfig({
  DATABASE_URL: "postgresql://localhost/fixture",
  TUDA_MASTER_KEY: "fixture-".repeat(10),
  TUDA_COMPANY_ORIGIN: "https://company.example",
  TUDA_COMPANY_NAS_SERVICE_TOKEN: "nas-service-secret",
  TUDA_COMPANY_ORGANIZATION_ID: "approved-org",
});
it("introspects only the storage token with NAS's own private service credential", async () => {
  const auth = new CompanyStorageAuth(config, (async (url, init) => {
    expect(url).toBe(
      "https://company.example/api/company/v1/storage/introspect",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer nas-service-secret",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      token: "storage-only-token",
    });
    return Response.json({
      ok: true,
      data: {
        contract: 1,
        active: true,
        appId: "tuda",
        audience: "tuda-nas",
        organizationId: "approved-org",
        memberId: "member",
        sessionId: "device",
        scopes: ["boards:read"],
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
      },
    });
  }) as typeof fetch);
  const principal = await auth.authenticate("storage-only-token");
  expect(principal).toMatchObject({
    id: "member",
    role: "viewer",
    orgId: config.organizationId,
  });
  expect(() => requireStorageScope(principal, "boards:write")).toThrow();
  expect(commandStorageScopes("boards:get")).toEqual(["boards:read"]);
  expect(() => commandStorageScopes("image:generate")).toThrow();
});
it.each([
  { active: false },
  { appId: "codex-own" },
  { audience: "models" },
  { organizationId: "other" },
  { expiresAt: "invalid" },
  { expiresAt: new Date(Date.now() - 1000).toISOString() },
])("rejects invalid or cross-scope storage grants %j", async (override) => {
  const auth = new CompanyStorageAuth(config, (async () =>
    Response.json({
      ok: true,
      data: {
        contract: 1,
        active: true,
        appId: "tuda",
        audience: "tuda-nas",
        organizationId: "approved-org",
        memberId: "member",
        sessionId: "device",
        scopes: ["boards:read"],
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
        ...override,
      },
    })) as typeof fetch);
  await expect(auth.authenticate("token")).rejects.toThrow();
});

it.each([
  [429, "STORAGE_AUTH_RATE_LIMITED", "稍后重试保存"],
  [401, "STORAGE_AUTH_SERVICE_REJECTED", "管理员"],
  [403, "STORAGE_AUTH_SERVICE_REJECTED", "管理员"],
  [502, "STORAGE_AUTH_UNAVAILABLE", "HTTP 502"],
])("classifies introspection HTTP %i without exposing credentials", async (status, code, message) => {
  const auth = new CompanyStorageAuth(config, (async () =>
    new Response("upstream-private-details", { status: status as number })) as typeof fetch);
  await expect(auth.authenticate("private-user-token")).rejects.toMatchObject({ code, message: expect.stringContaining(message as string) });
});
