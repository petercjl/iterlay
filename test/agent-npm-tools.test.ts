import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNpmPackageTools, npmPackageName, npmToolEnvironment } from "../electron/agents/npm-tools.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tuda-npm-test-")); directories.push(dir);
  const root = path.join(dir, "npm-tools");
  const pkg = path.join(root, "node_modules", "@fixture", "cli");
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@fixture/cli": "1.2.3" } }));
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "@fixture/cli", version: "1.2.3", bin: { "fixture-cli": "cli.mjs" } }));
  await writeFile(path.join(pkg, "cli.mjs"), 'console.log(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), hasKey: Boolean(process.env.TUDA_NPM_TEST_SECRET)}))');
  const tools = createNpmPackageTools(dir);
  const invoke = (name: string, args: unknown, signal?: AbortSignal) => tools.find(t => t.name === name)!.execute("test", args, signal, undefined, {} as never);
  return { root, pkg, invoke };
}

describe("Tuda npm package capability", () => {
  it("accepts scoped packages and versions, rejects flags, URLs, file paths and traversal", () => {
    expect(npmPackageName("@petercjl/portable-skill-creator@0.2.1")).toBe("@petercjl/portable-skill-creator");
    expect(npmPackageName("kleur@latest")).toBe("kleur");
    for (const value of ["--global", "../cli", "file:/tmp/cli", "https://x/cli", "foo;echo", "foo bar", "@x/../../foo"]) expect(() => npmPackageName(value)).toThrow();
  });
  it("keeps package inventory scoped and verifies the installed entry without shell interpolation", async () => {
    const f = await fixture();
    const inventory = await f.invoke("manage_npm_package", { action: "list" });
    expect(JSON.stringify(inventory)).toContain('1.2.3');
    process.env.TUDA_NPM_TEST_SECRET = "must-not-reach-package";
    try {
      const output = await f.invoke("run_npm_package", { package: "@fixture/cli", args: ["$(touch unwanted)", "a b", "--help"] });
      const payload = JSON.parse((output.content[0] as { text: string }).text);
      expect(JSON.parse(payload.output).hasKey).toBe(false);
      expect(JSON.stringify(output)).toContain("$(touch unwanted)");
      expect(JSON.stringify(output)).toContain("1.2.3");
    } finally { delete process.env.TUDA_NPM_TEST_SECRET; }
    const other = createNpmPackageTools(path.join(f.root, "other"))[0];
    const empty = await other.execute("list", { action: "list" }, undefined, undefined, {} as never);
    expect(JSON.parse((empty.content[0] as { text: string }).text).packages).toEqual([]);
  });
  it("rejects undeclared commands, escaping entrypoints and supports cancellation", async () => {
    const f = await fixture();
    await expect(f.invoke("run_npm_package", { package: "@fixture/cli", command: "sh", args: [] })).rejects.toThrow("请选择");
    const controller = new AbortController(); controller.abort();
    await expect(f.invoke("run_npm_package", { package: "@fixture/cli", args: [] }, controller.signal)).rejects.toThrow("停止");
    await writeFile(path.join(f.pkg, "package.json"), JSON.stringify({ version: "1.2.3", bin: { cli: "../../../outside.mjs" } }));
    await writeFile(path.join(f.root, "outside.mjs"), "");
    await expect(f.invoke("run_npm_package", { package: "@fixture/cli", args: [] })).rejects.toThrow("超出");
    expect(await readFile(path.join(f.root, "outside.mjs"), "utf8")).toBe("");
  });
  it("does not pass model credentials or npm user tokens into child tools", () => {
    expect(npmToolEnvironment("/scoped")).not.toHaveProperty("OPENAI_API_KEY");
    expect(npmToolEnvironment("/scoped")).not.toHaveProperty("NODE_OPTIONS");
    expect(npmToolEnvironment("/scoped").npm_config_registry).toBe("https://registry.npmjs.org");
    process.env.TUDA_NPM_TEST_SECRET = "private";
    const previousProxy = process.env.https_proxy;
    process.env.https_proxy = "http://127.0.0.1:12345";
    try {
      expect(npmToolEnvironment("/scoped").https_proxy).toBe("http://127.0.0.1:12345");
      expect(npmToolEnvironment("/scoped")).not.toHaveProperty("TUDA_NPM_TEST_SECRET");
    } finally {
      delete process.env.TUDA_NPM_TEST_SECRET;
      if (previousProxy === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = previousProxy;
    }
  });
});
