import { expect, it } from "vitest";
import { DingTalkProvider } from "../enterprise/src/auth.js";
import { readConfig } from "../enterprise/src/config.js";

const config = () => readConfig({ DATABASE_URL: "postgresql://localhost/test", TUDA_MASTER_KEY: "test-master-key-".repeat(4), DINGTALK_CORP_ID: "company", DINGTALK_CLIENT_ID: "client", DINGTALK_CLIENT_SECRET: "secret" });
it("uses the existing workbench login scopes without organization directory APIs", async () => {
  const calls: string[] = [];
  const provider = new DingTalkProvider(config(), (async (url, options) => {
    calls.push(String(url));
    if (String(url).endsWith("/userAccessToken")) {
      expect(JSON.parse(String(options?.body))).toMatchObject({ clientId: "client", grantType: "authorization_code", code: "code" });
      return Response.json({ accessToken: "test-token", corpId: "company" });
    }
    expect(new Headers(options?.headers).get("x-acs-dingtalk-access-token")).toBe("test-token");
    return Response.json({ unionId: "stable-user", nick: "成员" });
  }) as typeof fetch);
  const result = await provider.exchange("code");
  expect(result).toMatchObject({ corpId: "company", unionId: "stable-user", name: "成员" });
  expect(calls).toEqual(["https://api.dingtalk.com/v1.0/oauth2/userAccessToken", "https://api.dingtalk.com/v1.0/contact/users/me"]);
});
it.each(["other-company", undefined])("rejects unauthorized or missing selected corporate identity %s", async corpId => {
  let calls = 0;
  const provider = new DingTalkProvider(config(), (async () => { calls++; return Response.json({ accessToken: "test-token", corpId }); }) as typeof fetch);
  await expect(provider.exchange("code")).rejects.toMatchObject({ status: 403, code: "ORGANIZATION_DENIED" });
  expect(calls).toBe(1);
});
