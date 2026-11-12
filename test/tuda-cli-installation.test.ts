import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { getCliInstallationStatus, installCli } from "../electron/cli-installation.js";

it.skipIf(process.platform === "win32")("recognizes and preserves an npm-owned Tuda launcher", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "tuda-cli-owner-"));
  try {
    const root = path.join(homeDir, ".local/lib/node_modules/@petercjl/tuda");
    const entry = path.join(root, "dist/main.js");
    const target = path.join(homeDir, ".local/bin/tuda");
    await mkdir(path.dirname(entry), { recursive: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(entry, "#!/usr/bin/env node\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@petercjl/tuda", bin: { tuda: "dist/main.js" } }));
    await symlink(entry, target);
    expect((await getCliInstallationStatus(homeDir)).installed).toBe(true);
    expect((await installCli({ homeDir, executable: process.execPath, scriptPath: entry })).installed).toBe(true);
    expect(await readFile(target, "utf8")).toBe("#!/usr/bin/env node\n");
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
