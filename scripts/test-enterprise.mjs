import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
await mkdir("tmp", { recursive: true });
const directory = await mkdtemp(path.resolve("tmp/tuda-enterprise-check-"));
try {
  const entry = path.join(directory, "integration.mjs");
  await build({ entryPoints: [process.argv.includes("--company-storage") ? "enterprise/test/company-storage.ts" : "enterprise/test/integration.ts"], outfile: entry, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external" });
  const child = spawn(process.execPath, [entry], { stdio: "inherit", env: process.env });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
  process.exitCode = Number(code);
} finally { await rm(directory, { recursive: true, force: true }); }
