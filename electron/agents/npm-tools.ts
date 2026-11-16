import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "./coding-runtime.js";

const require = createRequire(import.meta.url);
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9.*^~>=<|+-]+)?$/;
const queues = new Map<string, Promise<unknown>>();

export function npmPackageName(spec: string): string {
  if (!packagePattern.test(spec)) throw new Error("请输入 npm 包名及可选版本；支持公共 npm registry 包。");
  return spec.slice(0, spec.indexOf("@", 1) === -1 ? undefined : spec.indexOf("@", 1));
}

/** Child tools receive ordinary runtime variables, never the application's model credentials. */
export function npmToolEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|home|userprofile|systemroot|windir|comspec|pathext|temp|tmp|tmpdir|lang|lc_all|appdata|localappdata|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file)$/i.test(key)) env[key] = value;
  }
  return { ...env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1",
    npm_config_cache: path.join(root, "cache"),
    npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_globalconfig: path.join(root, "global-npmrc"),
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_update_notifier: "false" };
}

export function runNpmToolProcess(entry: string, args: string[], cwd: string, root: string, signal?: AbortSignal, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [entry, ...args], {
      cwd, env: npmToolEnvironment(root), signal, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(signal?.aborted ? "操作已停止，重新检查已安装状态后继续。"
        : `npm 工具执行失败：${(stderr || stdout || error.message).slice(-8000)}`));
      else resolve(stdout.slice(-32_000));
    });
  });
}

async function installed(root: string, name: string) {
  const directory = path.join(root, "node_modules", name);
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as {
    name: string; version: string; bin?: string | Record<string, string>; engines?: Record<string, string>;
  };
  const bins = typeof metadata.bin === "string" ? { [name.split("/").at(-1)!]: metadata.bin } : metadata.bin ?? {};
  return { name, version: metadata.version, directory, bins, engines: metadata.engines };
}

async function prepare(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [name, content] of [["package.json", '{"name":"tuda-user-tools","private":true,"version":"1.0.0"}\n'], ["npmrc", ""], ["global-npmrc", ""]]) {
    await writeFile(path.join(root, name), content, { flag: "wx", mode: 0o600 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
  const backup = path.join(root, "backups", crypto.randomUUID());
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const file of ["package.json", "package-lock.json"]) {
    await copyFile(path.join(root, file), path.join(backup, file)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** App-owned tools, independent of Pi's optional unrestricted Shell permission. */
export function createNpmPackageTools(agentDir: string): ToolDefinition[] {
  const root = path.join(agentDir, "npm-tools");
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
  return [{
    name: "manage_npm_package", label: "管理 npm 包",
    description: "在当前 Tuda 账号/空间的持久目录安装、更新或列出公共 npm 包，无需 Shell 或系统 npm。用户明确要求安装/更新时使用 install；指定版本原样保留，未指定用 registry 默认稳定版。安装跳过生命周期脚本；依赖原生编译或安装脚本的包需另行处理。不会安装到 Tuda 源码或全局目录。安装后用 run_npm_package 验证 --help/版本；包自带 Skill 时读取其当前文档，通过包自己的入口将 Skill 安装到本轮 skillDirectory，只管理当前 Tuda。包代码具有当前用户权限，仅按用户请求调用。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("install"), Type.Literal("list")]),
      package: Type.Optional(Type.String({ description: "npm 包名，可带版本，例如 @scope/name@1.2.3" })) }),
    executionMode: "sequential",
    execute: async (_id, raw, signal) => {
      const args = raw as { action: string; package?: string };
      if (args.action === "list") {
        // Await an in-flight installation so the inventory has a consistent manifest.
        await queues.get(root)?.catch(() => undefined);
        let manifest: { dependencies?: Record<string, string> };
        try { manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result({ directory: root, packages: [] }); throw error; }
        return result({ directory: root, packages: await Promise.all(Object.keys(manifest.dependencies ?? {}).map(name =>
          installed(root, npmPackageName(name)).catch(() => ({ name, error: "安装不完整，请重新安装" })))) });
      }
      if (args.action !== "install" || !args.package) throw new Error("安装需要指定 npm 包名。");
      const spec = args.package;
      const name = npmPackageName(spec);
      const previous = queues.get(root) ?? Promise.resolve();
      const job = previous.catch(() => undefined).then(async () => {
        signal?.throwIfAborted();
        await prepare(root);
        const entry = path.join(path.dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js");
        await runNpmToolProcess(entry, ["install", spec, "--prefix", root, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=1", "--fetch-timeout=30000", "--registry=https://registry.npmjs.org"], root, root, signal, 300_000);
        return result({ ...await installed(root, name), scriptsSkipped: true, skillDirectory: path.join(agentDir, "skills"),
          next: "使用 run_npm_package 运行已安装包的 --help 或版本命令，核对包的真实使用方式。" });
      });
      queues.set(root, job);
      try { return await job; } finally { if (queues.get(root) === job) queues.delete(root); }
    }
  }, {
    name: "run_npm_package", label: "运行 npm 工具",
    description: "运行 manage_npm_package 已安装包的 Node.js CLI，参数以字符串数组传入，不使用 Shell，不隐式下载安装。先 --help 了解真实能力；只执行用户授权的任务。可通过包的 Skill 管理命令安装/更新当前 Tuda Skill，之后重新加载 Skill。独立可执行文件和需要系统 Node 子进程的工具可能需要额外运行环境。",
    parameters: Type.Object({ package: Type.String(), command: Type.Optional(Type.String({ description: "package.json 的 bin 名；只有一个时可省略" })),
      args: Type.Array(Type.String()), timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }),
    executionMode: "sequential",
    execute: async (_id, raw, signal) => {
      const args = raw as { package: string; command?: string; args: string[]; timeoutSeconds?: number };
      await queues.get(root)?.catch(() => undefined);
      const pkg = await installed(root, npmPackageName(args.package));
      const command = args.command ?? (Object.keys(pkg.bins).length === 1 ? Object.keys(pkg.bins)[0] : "");
      if (!Object.hasOwn(pkg.bins, command)) throw new Error(`请选择包提供的 CLI：${Object.keys(pkg.bins).join(", ") || "此包没有 CLI"}`);
      const entry = await realpath(path.resolve(pkg.directory, pkg.bins[command]));
      const relative = path.relative(await realpath(pkg.directory), entry);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("包的 CLI 入口超出了包目录。");
      return result({ package: pkg.name, version: pkg.version, command, directory: root,
        output: await runNpmToolProcess(entry, args.args, root, root, signal, (args.timeoutSeconds ?? 120) * 1000) });
    }
  }];
}
