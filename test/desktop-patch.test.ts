import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageDesktopPatch } from "../electron/updater/desktop-patch.js";
import { NpmUpdateApiClient } from "../electron/updater/npm-api-client.js";
import { validDesktopPatch } from "../shared/desktop-patch.js";
import type { UpdateManifest } from "../shared/app-update.js";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const base = ["the old main executable", "the old application code"];
const target = ["the new main executable", "the new application code"];
const names = ["Tuda.exe", "resources/app.asar"];
const changed = { offset: 4, size: 3 };
const data = Buffer.from(target.map(file => file.slice(changed.offset, changed.offset+changed.size)).join(""));
const part = { sha256: hash(data), fileSize: data.length,
  url: `https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${hash(data)}.tgz` };
const patch: UpdateManifest = {
  version: "0.1.10", platform: "win32", arch: "x64", channel: "stable", sha256: part.sha256,
  downloadUrl: part.url, fileSize: part.fileSize, npmPayloads: [part],
  patch: { baseVersion: "0.1.9", files: names.map((name, index) => ({
    path: name, fileSize: Buffer.byteLength(target[index]), baseSha256: hash(base[index]), sha256: hash(target[index]), ranges: [changed],
  })) },
};
const { patch: _delta, ...installer } = patch;
const bridge = { ...installer, version: "0.1.9" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("desktop differential release", () => {
  const query = { platform: "win32" as const, arch: "x64" as const };
  const reader = () => vi.fn(async (url: string | URL | Request) => String(url).endsWith("/desktop-patch")
    ? Response.json({ version: patch.version, tudaPatchRelease: { schemaVersion: 1, applicationVersion: patch.version, patches: [patch] } })
    : Response.json({ version: bridge.version, tudaRelease: { schemaVersion: 1, applicationVersion: bridge.version, installers: [bridge] } }));

  it("keeps the bridge visible to old installs and selects a patch only for its exact base", async () => {
    const fetcher = reader();
    const client = new NpmUpdateApiClient(fetcher);
    expect(await client.fetchLatest({ ...query, currentVersion: "0.1.3" })).toEqual(bridge);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client.fetchLatest({ ...query, currentVersion: "0.1.9" })).toMatchObject(patch);
    expect(await client.fetchLatest({ ...query, currentVersion: "0.1.10" })).toEqual(bridge);
  });

  it("rejects file paths outside the patch contract and duplicate entries", () => {
    expect(validDesktopPatch(patch)).toBe(true);
    expect(validDesktopPatch({ ...patch, patch: { ...patch.patch!, files: [
      { ...patch.patch!.files[0], path: "../settings.json" }, patch.patch!.files[1],
    ] } })).toBe(false);
    expect(validDesktopPatch({ ...patch, patch: { ...patch.patch!, files: [patch.patch!.files[0], patch.patch!.files[0]] } })).toBe(false);
    const [first, second] = patch.patch!.files;
    expect(validDesktopPatch({ ...patch, patch: { ...patch.patch!, files: [
      { ...first, ranges: [changed, { offset: 5, size: 2 }] }, second
    ] } })).toBe(false);
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "tuda-patch-test-"));
    dirs.push(root);
    const dataRoot = path.join(root, "user-data");
    const appRoot = path.join(root, "app");
    await mkdir(dataRoot);
    await mkdir(path.join(appRoot, "resources"), { recursive: true });
    await Promise.all([
      ...names.map((name, index) => writeFile(path.join(appRoot, name), base[index])),
      writeFile(path.join(appRoot, "uninstaller.exe"), "original uninstaller"),
      writeFile(path.join(dataRoot, "board.json"), "original board"),
      writeFile(path.join(dataRoot, "settings.json"), "original settings"),
      writeFile(path.join(root, "update.patch"), data),
    ]);
    return { appRoot: await realpath(appRoot), dataRoot, downloaded: path.join(root, "update.patch") };
  }

  it("stages a validated clone while preserving the installed app, board and settings", async () => {
    const { appRoot, dataRoot, downloaded } = await fixture();
    const staged = await stageDesktopPatch(downloaded, path.join(appRoot, "Tuda.exe"), patch);
    for (const [index, name] of names.entries()) {
      expect(await readFile(path.join(appRoot, name), "utf8")).toBe(base[index]);
      expect(await readFile(path.join(staged.candidate, name), "utf8")).toBe(target[index]);
    }
    expect(await readFile(path.join(staged.candidate, "uninstaller.exe"), "utf8")).toBe("original uninstaller");
    expect(await readFile(path.join(dataRoot, "board.json"), "utf8")).toBe("original board");
    expect(await readFile(path.join(dataRoot, "settings.json"), "utf8")).toBe("original settings");
  });

  it("refuses to apply a patch to an altered base or damaged download", async () => {
    const { appRoot, downloaded } = await fixture();
    await writeFile(path.join(appRoot, "resources/app.asar"), "modified");
    await expect(stageDesktopPatch(downloaded, path.join(appRoot, "Tuda.exe"), patch)).rejects.toThrow("基线不一致");
    await writeFile(downloaded, "damaged update");
    await expect(stageDesktopPatch(downloaded, path.join(appRoot, "Tuda.exe"), patch)).rejects.toThrow("差分文件校验失败");
    expect(await readFile(path.join(appRoot, "resources/app.asar"), "utf8")).toBe("modified");
  });
});
