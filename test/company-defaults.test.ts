import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadCompanyDefaults } from "../electron/company/defaults.js";

it("loads managed defaults without embedding deployment addresses in the application", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-defaults-"));
  const resources = path.join(root, "resources"),
    user = path.join(root, "user");
  const oldOrigin = process.env.TUDA_COMPANY_URL,
    oldNas = process.env.TUDA_NAS_URL;
  try {
    delete process.env.TUDA_COMPANY_URL;
    delete process.env.TUDA_NAS_URL;
    await mkdir(resources);
    await mkdir(user);
    expect(await loadCompanyDefaults(user, resources)).toEqual({});
    await writeFile(
      path.join(resources, "company-defaults.json"),
      JSON.stringify({
        accountOrigin: "https://company.example",
        nasUrl: "https://nas.example",
      }),
      { flag: "wx" },
    );
    await writeFile(
      path.join(user, "company-defaults.json"),
      JSON.stringify({ nasUrl: "https://custom-nas.example" }),
      { flag: "wx", mode: 0o600 },
    );
    expect(await loadCompanyDefaults(user, resources)).toEqual({
      accountOrigin: "https://company.example",
      nasUrl: "https://custom-nas.example",
    });
    process.env.TUDA_NAS_URL = "https://dev-nas.example";
    expect((await loadCompanyDefaults(user, resources)).nasUrl).toBe(
      "https://dev-nas.example",
    );
  } finally {
    if (oldOrigin === undefined) delete process.env.TUDA_COMPANY_URL;
    else process.env.TUDA_COMPANY_URL = oldOrigin;
    if (oldNas === undefined) delete process.env.TUDA_NAS_URL;
    else process.env.TUDA_NAS_URL = oldNas;
    await rm(root, { recursive: true, force: true });
  }
});
