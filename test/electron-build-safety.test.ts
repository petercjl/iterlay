import { mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("does not emit a broken Electron entry before a new dependency exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-emit-safety-"));
  try {
    const config = JSON.parse(await readFile(new URL("../electron/tsconfig.json", import.meta.url), "utf8"));
    await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", types: [],
        outDir: "dist", noEmitOnError: config.compilerOptions.noEmitOnError, skipLibCheck: true },
      include: ["*.ts"]
    }), { flag: "wx" });
    await writeFile(path.join(directory, "main.ts"), 'import { ready } from "./new-dependency.js"; console.log(ready);', { flag: "wx" });
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const compile = () => spawnSync(process.execPath, [tsc, "-p", directory], { encoding: "utf8" });
    const broken = compile();
    expect(broken.status).not.toBe(0);
    expect(broken.stdout).toContain("TS2307");
    await expect(access(path.join(directory, "dist/main.js"))).rejects.toThrow();
    await writeFile(path.join(directory, "new-dependency.ts"), "export const ready = true;", { flag: "wx" });
    const fixed = compile();
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    await expect(access(path.join(directory, "dist/main.js"))).resolves.toBeUndefined();
    await expect(access(path.join(directory, "dist/new-dependency.js"))).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
