import { expect, it, vi } from "vitest";
import {
  CompanyAccount,
  companyOrigin,
  validateBootstrap,
} from "../electron/company/account.js";
import type {
  CompanyBootstrap,
  CompanySession,
} from "../shared/company-account.js";
const origin = "https://account.example.test";
const session: CompanySession = {
  contract: 1,
  appId: "tuda",
  sessionId: "device",
  token: "employee-private-token",
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  member: { id: "member", name: "员工" },
  organization: { id: "organization", name: "企业" },
};
export const bootstrap: CompanyBootstrap = {
  contract: 1,
  appId: "tuda",
  sessionId: "device",
  configVersion: "1",
  member: session.member,
  organization: session.organization,
  text: {
    enabled: true,
    defaultModel: "gateway/model",
    providers: [
      {
        id: "gateway",
        name: "共享文本",
        protocol: "openai-responses",
        baseUrl: origin + "/api/company/v1/proxy/tuda/gateway/v1",
        models: [{ id: "model", name: "文本" }],
      },
    ],
  },
  image: { enabled: false, reason: "KEY_BINDING_UNVERIFIED", models: [] },
  storage: { enabled: false, reason: "STORAGE_NOT_CONFIGURED" },
};
const direct = {contract:2,appId:"tuda",sessionId:session.sessionId,authenticated:true,expiresAt:session.expiresAt,member:session.member,organization:session.organization,transport:"direct",subject:"a".repeat(64),configVersion:"b".repeat(64),model:"gateway/model",
  provider:{gateway:{name:"共享文本",wire_api:"responses",options:{baseURL:"https://models.example.test/v1",apiKey:"fixture-provider-key"},models:{model:{name:"文本",limit:{context:128000,output:16384}}}}}};
const lease = {subject:direct.subject,configVersion:direct.configVersion,authorization:{validForSeconds:300,refreshAfterSeconds:120}};
it("rejects insecure remote account origins and cross-app/model credential destinations", () => {
  expect(() => companyOrigin("http://192.168.1.2:1234")).toThrow();
  expect(companyOrigin("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
  for (const mutate of [
    (b: CompanyBootstrap) => (b.member = { id: "other", name: "其他" }),
    (b: CompanyBootstrap) =>
      (b.text.providers[0].baseUrl = "https://evil.test/v1"),
    (b: CompanyBootstrap) =>
      (b.text.providers[0].protocol = "responses" as never),
  ]) {
    const b = structuredClone(bootstrap);
    mutate(b);
    expect(() => validateBootstrap(b, session, origin)).toThrow();
  }
});
it("keeps text enabled independently of employee image binding and never exposes credentials in status", async () => {
  const account = new CompanyAccount(origin, async () => undefined);
  await account.restore({ origin, session, bootstrap });
  expect(account.status).toMatchObject({
    authenticated: true,
    textModels: 1,
    imageModels: 0,
    imageReason: "KEY_BINDING_UNVERIFIED",
  });
  expect(JSON.stringify(account.status)).not.toContain(session.token);
});
it("uses a local verifier, validates authorization URL and claims once with app scope", async () => {
  vi.useFakeTimers();
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }> = [];
  const saved: unknown[] = [];
  const id = "a".repeat(43);
  const account = new CompanyAccount(
    origin,
    async (v) => {
      saved.push(structuredClone(v));
    },
    (async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({
        url: String(url),
        body,
        headers: new Headers(init?.headers),
      });
      let data: unknown;
      if (String(url).endsWith("/auth/start")) {
        expect(body.verifierHash).toMatch(/^[a-f0-9]{64}$/);
        expect(body.verifier).toBeUndefined();
        data = {
          contract: 1,
          appId: "tuda",
          requestId: id,
          userCode: "AAAAAAAA",
          verificationUrl:
            origin + "/api/company/v1/auth/authorize?request=" + id,
          expiresIn: 600,
          intervalMs: 2000,
        };
      } else if (String(url).endsWith("/auth/poll")) {
        expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        data = { ...session, status: "authorized" };
      } else if (String(url).endsWith("/session"))
        data = { ...session, ...lease, token: undefined, authenticated: true };
      else if (String(url).endsWith("/direct-models")) data = direct;
      else data = bootstrap;
      return Response.json({ ok: true, data });
    }) as typeof fetch,
  );
  try {
    const login = await account.beginLogin();
    expect(JSON.stringify(login)).not.toContain("verifier");
    expect(await account.pollLogin()).toEqual({ status: "pending" });
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(await account.pollLogin()).toEqual({ status: "authorized" });
    expect(calls.at(-1)?.headers.get("X-Company-App-Id")).toBe("tuda");
    expect(saved).toHaveLength(2);
    await expect(account.pollLogin()).rejects.toThrow("过期");
  } finally {
    vi.useRealTimers();
  }
});
it("clears active credentials on revocation but retains an unexpired cache on network failure", async () => {
  let revoked = false;
  const account = new CompanyAccount(
    origin,
    async () => undefined,
    (async () => {
      if (revoked) return Response.json({}, { status: 401 });
      throw new Error("offline");
    }) as typeof fetch,
  );
  await account.restore({ origin, session, bootstrap });
  await expect(account.refresh()).rejects.toThrow();
  expect(account.authenticated).toBe(true);
  revoked = true;
  await expect(account.refresh()).rejects.toThrow();
  expect(account.authenticated).toBe(false);
  expect(account.bootstrap).toBeUndefined();
});

it("keeps company login and text models when NAS permission alone is denied", async () => {
  const account = new CompanyAccount(origin, async () => undefined, (async () =>
    Response.json(
      {
        ok: false,
        error: {
          code: "STORAGE_NOT_GRANTED",
          message: "private upstream detail",
        },
      },
      { status: 403 },
    )) as typeof fetch);
  await account.restore({
    origin,
    session,
    bootstrap: {
      ...bootstrap,
      storage: { enabled: true, scopes: ["boards:read", "assets:read"] },
    },
  });
  await expect(account.storageToken()).rejects.toThrow("本地空间");
  expect(account.status).toMatchObject({ authenticated: true, textModels: 1 });
  expect(JSON.stringify(account.status)).not.toContain(
    "private upstream detail",
  );
});

it("refreshes DingTalk profile without changing account identity", async () => {
  const member = {...session.member, name: "钉钉新名称", avatarUrl: "https://static.dingtalk.com/avatar-fixture.png"};
  const account = new CompanyAccount(origin, async () => undefined, (async url => Response.json({ok:true,data: String(url).endsWith("/session") ? {...session,...lease, authenticated:true, member} : String(url).endsWith("/direct-models") ? direct : {...bootstrap, member}})) as typeof fetch);
  await account.restore({origin,session,bootstrap});await account.refresh();
  expect(account.status.member).toEqual(member);expect(account.session?.member).toEqual(member);
  expect(JSON.stringify(account.status)).not.toContain(session.token);
});
it.each(["javascript:alert(1)","data:image/png;base64,AA", "https://name:password@example.com/avatar"])("rejects unsafe avatar URL %s", async avatarUrl => {
  const account = new CompanyAccount(origin, async () => undefined);
  await expect(account.restore({origin,session:{...session,member:{...session.member,avatarUrl}}})).rejects.toThrow("公司设备授权格式无效");
});

it("requests a real profile OAuth and binds its return to the same employee", async () => {
  vi.useFakeTimers();
  const id = "p".repeat(43);let profileRequested = false;
  const account = new CompanyAccount(origin, async () => undefined, (async (url, init) => {
    if (String(url).endsWith("/auth/start")) {
      profileRequested = JSON.parse(String(init?.body)).refreshProfile === true;
      return Response.json({ok:true,data:{contract:1,appId:"tuda",requestId:id,userCode:id.slice(0,8).toUpperCase(),verificationUrl:origin+"/api/company/v1/auth/authorize?request="+id+"&refreshProfile=1",expiresIn:600,intervalMs:1000}});
    }
    return Response.json({ok:true,data:{...session,status:"authorized",member:{id:"another-employee",name:"Other"}}});
  }) as typeof fetch);
  try {
    await account.restore({origin,session,bootstrap});
    expect((await account.beginLogin(true)).authorizeUrl).toContain("refreshProfile=1");
    expect(profileRequested).toBe(true);vi.advanceTimersByTime(1100);
    await expect(account.pollLogin()).rejects.toThrow("当前登录的钉钉账号");
    expect(account.session?.member.id).toBe(session.member.id);
  } finally {vi.useRealTimers();}
});
