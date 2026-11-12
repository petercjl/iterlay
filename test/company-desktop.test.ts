import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString(),
  },
}));
import { dialog, safeStorage } from "electron";
import { CompanyDesktop } from "../electron/company/desktop.js";
import { inExecutionSpace } from "../electron/execution-space.js";
import type { EnterpriseClient } from "../electron/enterprise/client.js";
import { CompanyToapis } from "../electron/company/toapis.js";

it("defaults a new company account to NAS and reuses an explicitly chosen local folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-storage-default-"));
  const legacy = Object.assign(new EventEmitter(), {
    activeSpace: "personal",
    status: { pendingWrites: 0 },
    stop: vi.fn(),
  }) as unknown as EnterpriseClient;
  const company = new CompanyDesktop(root, legacy, {
    accountOrigin: "https://company.example",
    nasUrl: "https://nas.example",
  });
  try {
    await company.initialize();
    await company.account.restore({
      origin: company.account.origin,
      session: {
        contract: 1,
        appId: "tuda",
        sessionId: "device",
        token: "fixture-device",
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        member: { id: "employee", name: "员工" },
        organization: { id: "org", name: "公司" },
      },
    });
    expect(company.status).toMatchObject({
      storageKind: "nas",
      storageUrl: "https://nas.example",
    });
    expect(company.workspace).toContain("company-cache");
    expect(company.folder).toBeUndefined();
    vi.mocked(dialog.showOpenDialog).mockClear();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [path.join(root, "local")],
    });
    await company.chooseFolder(false);
    expect(company.status.storageKind).toBe("local");
    await company.chooseFolder(false, true);
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(company.status).toMatchObject({
      activeSpace: "enterprise",
      storageKind: "local",
      storageUrl: "https://nas.example",
      localFolder: path.join(root, "local"),
    });
  } finally {
    company.stop();
    await rm(root, { recursive: true, force: true });
  }
});
it("pins async store operations to the starting company folder and restores an independent account session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-company-desktop-"));
  let company: CompanyDesktop | undefined, restored: CompanyDesktop | undefined;
  const legacy = () =>
    Object.assign(new EventEmitter(), {
      activeSpace: "personal",
      status: { pendingWrites: 3 },
      stop: vi.fn(),
    }) as unknown as EnterpriseClient;
  try {
    process.env.TUDA_COMPANY_URL = "https://company.example";
    company = new CompanyDesktop(root, legacy());
    await company.initialize();
    const session = {
      contract: 1 as const,
      appId: "tuda" as const,
      sessionId: "s",
      token: "private-device-token",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      member: { id: "employee", name: "员工" },
      organization: { id: "org", name: "公司" },
    };
    await company.account.restore({ origin: company.account.origin, session });
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [path.join(root, "folder-A")],
    });
    await company.chooseFolder(false);
    expect(company.status.nasPendingWrites).toBe(3);
    await company.selectSpace("enterprise");
    const store = company.scopeStore({ root: "personal" }, (r) => ({
      root: r,
    }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = inExecutionSpace(async () => {
      await gate;
      return store.root;
    });
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [path.join(root, "folder-B")],
    });
    await company.chooseFolder(false);
    release();
    expect(await pending).toContain("folder-A");
    expect(store.root).toContain("folder-B");
    await company.account.configure(company.account.origin);
    expect(JSON.stringify(company.status)).not.toContain(
      "private-device-token",
    );
    const file = JSON.parse(
      await readFile(path.join(root, "company-session.json"), "utf8"),
    );
    expect(file.encrypted).toBeTypeOf("string");
    restored = new CompanyDesktop(root, legacy());
    await restored.initialize();
    expect(restored.account.authenticated).toBe(false);
  } finally {
    delete process.env.TUDA_COMPANY_URL;
    company?.stop();
    restored?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("automatically validates a newly granted image credential and disables it on entitlement removal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-auto-image-auth-"));
  const check = vi
    .spyOn(CompanyToapis.prototype, "testConnection")
    .mockResolvedValue();
  const legacy = Object.assign(new EventEmitter(), {
    activeSpace: "personal",
    status: { pendingWrites: 0 },
    stop: vi.fn(),
  }) as unknown as EnterpriseClient;
  const previous = process.env.TUDA_COMPANY_URL;
  let company: CompanyDesktop | undefined;
  try {
    process.env.TUDA_COMPANY_URL = "https://company.example";
    company = new CompanyDesktop(root, legacy);
    await company.initialize();
    const member = { id: "employee", name: "员工" },
      organization = { id: "organization", name: "公司" };
    const session = {
      contract: 1 as const,
      appId: "tuda" as const,
      sessionId: "device",
      token: "fixture-device",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      member,
      organization,
    };
    const bootstrap = {
      contract: 1 as const,
      appId: "tuda" as const,
      sessionId: "device",
      configVersion: "1",
      member,
      organization,
      text: { enabled: false, defaultModel: null, providers: [] },
      image: {
        enabled: true,
        adapter: "toapiscli" as const,
        package: "@petercjl/toapiscli" as const,
        credential: {
          schemaVersion: 1 as const,
          site: "cn" as const,
          apiKey: "fixture-private-image-key",
        },
        models: ["gpt-image-2.6-sunburst"],
      },
      storage: { enabled: false },
    };
    await company.account.restore({
      origin: company.account.origin,
      session,
      bootstrap,
    });
    await vi.waitFor(() => expect(company?.status.imageConfigured).toBe(true));
    expect(check).toHaveBeenCalledOnce();
    expect(company.token("company-image/gpt-image-2.6-sunburst")).toBe(
      "managed-toapis",
    );
    expect(JSON.stringify(company.status)).not.toContain(
      "fixture-private-image-key",
    );
    await company.account.restore({
      origin: company.account.origin,
      session,
      bootstrap: {
        ...bootstrap,
        configVersion: "2",
        image: { enabled: false, reason: "IMAGE_NOT_GRANTED", models: [] },
      },
    });
    expect(company.status.imageConfigured).toBe(false);
    expect(company.token("company-image/gpt-image-2.6-sunburst")).toBe("");
  } finally {
    company?.stop();
    check.mockRestore();
    if (previous === undefined) delete process.env.TUDA_COMPANY_URL;
    else process.env.TUDA_COMPANY_URL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps embedded grants memory-only and never restores a prior host through the OS keychain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-embedded-session-"));
  const legacy = Object.assign(new EventEmitter(), { activeSpace: "personal", status: { pendingWrites: 0 }, stop: vi.fn() }) as unknown as EnterpriseClient;
  const decrypt = vi.spyOn(safeStorage, "decryptString"), encrypt = vi.spyOn(safeStorage, "encryptString");
  vi.stubEnv("TUDA_EMBEDDED_HOST", "codex-own");
  const company = new CompanyDesktop(root, legacy, { accountOrigin: "https://company.example" });
  try {
    await writeFile(path.join(root, "company-session.json"), JSON.stringify({ version: 1, encrypted: "legacy-host-grant" }), { flag: "wx", mode: 0o600 });
    await company.initialize();
    expect(company.status.authenticated).toBe(false);
    expect(decrypt).not.toHaveBeenCalled();
    await company.account.configure("https://company.example");
    expect(encrypt).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(root, "company-session.json"), "utf8")).encrypted).toBe("legacy-host-grant");
  } finally { company.stop(); decrypt.mockRestore(); encrypt.mockRestore(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
