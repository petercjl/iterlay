import { expect, it, vi } from "vitest";
import { EnterpriseClient } from "../electron/enterprise/client.js";
vi.mock("electron", () => ({ safeStorage: {} }));
it("keeps observed board revisions across same-account storage reconnects", async () => {
  const client = new EnterpriseClient("/unused-storage-fixture", async () => undefined, () => undefined);
  const internals = client as unknown as {
    config: { version: number; serverUrl: string; activeSpace: string };
    session: { token: string; expiresAt: string; organizationId: string; organizationName: string; user: {id: string; name: string; role: "editor"} };
    documents: Map<string, unknown>; versions: Map<string, string>; boardIds: Set<string>;
    connect(): void;
  };
  const session = { token: "fixture", expiresAt: new Date(Date.now()+240000).toISOString(), organizationId: "org", organizationName: "Org", user: { id: "member", name: "Member", role: "editor" as const } };
  internals.config = { version: 1, serverUrl: "https://nas.example", activeSpace: "enterprise" };
  internals.session = session;
  internals.documents.set("board", {state: "observed", epoch: "epoch", revision: 3});
  internals.versions.set("board:3", "observed"); internals.boardIds.add("board");
  vi.spyOn(client, "refreshIdentity").mockResolvedValue({ providers: {image: false, imageModel: "", text: false, textModel: ""} });
  vi.spyOn(client, "replayPending").mockResolvedValue();
  vi.spyOn(internals, "connect").mockImplementation(() => undefined);
  await client.useStorageSession("https://nas.example", async () => ({...session, token: "renewed"}));
  expect(internals.versions.get("board:3")).toBe("observed");
  expect(internals.documents.has("board")).toBe(true); expect(client.ownsBoard("board")).toBe(true);
  await client.useStorageSession("https://other-nas.example", async () => session);
  expect(internals.versions.size).toBe(0); expect(client.ownsBoard("board")).toBe(false);
});
