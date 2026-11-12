import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultUserDataPath } from "./paths.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "using-tuda";
const owner = "@petercjl/tuda";
const receiptName = ".tuda-skill.json";
const exists = (p: string) => access(p).then(() => true, () => false);
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const json = (value: unknown) => process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, ...value as object }, null, 2) + "\n");
const source = path.join(root, "skills", skillName);

async function digest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(dir: string, prefix = "") {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([receiptName, ".runtime", "agents"].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error("UNSAFE_SKILL_LINK");
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), name);
      else if (entry.isFile()) hash.update(name + "\0").update(await readFile(path.join(dir, entry.name)));
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

function selectedTarget(args: string[]): string {
  const at = args.indexOf("--target");
  const raw = at >= 0 ? args[at + 1] : undefined;
  if (!raw || raw.startsWith("--") || !path.isAbsolute(raw)) throw new Error("TARGET_REQUIRED: --target must be the current Agent's absolute, exact Skill directory.");
  const target = path.resolve(raw);
  if (path.basename(target) !== skillName || target === path.parse(target).root || target === source) throw new Error("UNSAFE_TARGET: select a separate using-tuda directory.");
  return target;
}

export async function installSkill(target: string, activation: { rename?: (from: string, to: string) => Promise<void> } = {}) {
  const renameDirectory = activation.rename ?? rename;
  const pkg = await readJson(path.join(root, "package.json"));
  const expected = await digest(source);
  let backup: string | undefined;
  if (await exists(target)) {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("UNMANAGED_TARGET: links require an explicit migration.");
    const receipt = await readJson(path.join(target, receiptName)).catch(() => null);
    if (receipt?.package !== owner) throw new Error("UNMANAGED_TARGET: existing directory was preserved.");
    if (await digest(target) !== receipt.digest) throw new Error("LOCAL_EDITS: existing Skill was preserved.");
    const installedRuntime = await readFile(path.join(target, ".runtime", "dist", "main.js")).catch(() => null);
    const installedHash = installedRuntime ? createHash("sha256").update(installedRuntime).digest("hex") : null;
    const currentHash = createHash("sha256").update(await readFile(path.join(root, "dist", "main.js"))).digest("hex");
    if (installedHash && installedHash !== receipt.runtimeSha256) throw new Error("LOCAL_EDITS: target-owned runtime was preserved.");
    if (receipt.version === pkg.version && receipt.digest === expected && installedHash === currentHash) {
      return { target, installed: true, managed: true, current: true, version: pkg.version, digest: expected, changed: false, hostDiscovery: "pending" };
    }
    backup = `${target}.backup-${randomUUID()}`;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.install-${randomUUID()}`;
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true });
    await mkdir(path.join(staging, ".runtime"));
    for (const name of ["dist", "guard", "skills", "package.json", "capabilities.json", "release-manifest.json", "INSTALL.md", "UPDATE.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      if (await exists(path.join(root, name))) await cp(path.join(root, name), path.join(staging, ".runtime", name), { recursive: true });
    }
    if (backup && await exists(path.join(target, "agents"))) await cp(path.join(target, "agents"), path.join(staging, "agents"), { recursive: true, force: true });
    await writeFile(path.join(staging, receiptName), JSON.stringify({ schemaVersion: 1, package: owner, version: pkg.version, digest: expected, runtimeSha256: createHash("sha256").update(await readFile(path.join(staging, ".runtime", "dist", "main.js"))).digest("hex") }, null, 2), { flag: "wx" });
    let inPlace = false;
    let oldFiles: string[] = [];
    const files = async (at: string, prefix = ""): Promise<string[]> => {
      const result: string[] = [];
      for (const entry of await readdir(at, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("UNSAFE_SKILL_LINK");
        const relative = path.join(prefix, entry.name);
        if (entry.isDirectory()) result.push(...await files(path.join(at, entry.name), relative));
        else result.push(relative);
      }
      return result;
    };
    if (backup) {
      try { await renameDirectory(target, backup); }
      catch (error) {
        if (!["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        oldFiles = await files(target);
        await cp(target, backup, { recursive: true, errorOnExist: true });
        inPlace = true;
      }
    }
    const stagedFiles = await files(staging);
    try {
      if (inPlace) {
        await cp(staging, target, { recursive: true, force: true });
        for (const name of oldFiles) if (!stagedFiles.includes(name)) await rm(path.join(target, name), { force: true });
        if (await digest(target) !== expected) throw new Error("ACTIVATION_INTEGRITY_FAILED");
      } else await renameDirectory(staging, target);
    } catch (error) {
      if (backup) {
        if (inPlace) {
          await cp(backup, target, { recursive: true, force: true });
          for (const name of stagedFiles) if (!oldFiles.includes(name)) await rm(path.join(target, name), { force: true });
        } else await rename(backup, target);
      }
      throw error;
    }
    return { target, installed: true, managed: true, current: true, version: pkg.version, digest: expected, changed: true, backup, hostDiscovery: "pending" };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function registry(tag: string, timeout = 4_000) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(owner)}/${encodeURIComponent(tag)}`, { signal: AbortSignal.timeout(timeout) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`REGISTRY_ERROR: ${response.status}`);
  return response.json() as Promise<{ version: string }>;
}

/** Advisory only; never installs or changes an Agent configuration. */
export async function automaticUpdateCheck(): Promise<void> {
  if (process.env.TUDA_NO_UPDATE_CHECK === "1" || await exists(path.join(root, "..", ".git"))) return;
  const cache = path.join(defaultUserDataPath(), "cli-update-check.json");
  try {
    const previous = await readJson(cache).catch(() => null);
    if (previous && Date.now() - previous.checkedAt < 86_400_000) return;
    const own = await readJson(path.join(root, "package.json"));
    const latest = await registry("latest", 600);
    await mkdir(path.dirname(cache), { recursive: true });
    const temporary = `${cache}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify({ checkedAt: Date.now(), latest: latest?.version ?? null }), { flag: "wx" });
    await rename(temporary, cache);
    if (latest && latest.version !== own.version) process.stderr.write(`Tuda ${latest.version} is available; use tuda update check --json.\n`);
  } catch { /* Offline checks cannot block a canvas operation. */ }
}

export async function handleManagement(args: string[]): Promise<boolean> {
  const [group, action] = args;
  if (args.includes("--help") && args.includes("--json")) {
    const manifest = await readJson(path.join(root, "capabilities.json"));
    json({ ...manifest, options: manifest.commandContracts[`${group} ${action}`]?.options ?? {} });
    return true;
  }
  if (!["version", "--version", "capabilities", "skill", "update", "doctor"].includes(group)) return false;
  const allowed = new Set(["--json", "--version", "--target", "--agent", "--name", "--channel", "--user-data-path", "--no-launch", "--app-path"]);
  for (const arg of args.filter((arg) => arg.startsWith("--"))) if (!allowed.has(arg)) throw new Error(`UNKNOWN_OPTION: ${arg}`);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const agent = option("--agent");
  if (agent && !/^[a-z][a-z0-9-]{0,63}$/.test(agent)) throw new Error("INVALID_AGENT");
  const pkg = await readJson(path.join(root, "package.json"));
  if (group === "version" || group === "--version") {
    if (args.includes("--json")) json({ package: pkg.name, version: pkg.version });
    else process.stdout.write(pkg.version + "\n");
  } else if (group === "capabilities") json(await readJson(path.join(root, "capabilities.json")));
  else if (group === "doctor") {
    const checks = { node: Number(process.versions.node.split(".")[0]) >= 22, skill: await exists(path.join(source, "SKILL.md")), runtime: await exists(path.join(root, "dist", "main.js")) };
    json({ package: pkg.name, version: pkg.version, checks, runtimeReady: Object.values(checks).every(Boolean), desktopRequiredForCanvas: true, platforms: { darwin: "development", win32: "customer" } });
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } else if (group === "skill") {
    if (option("--name") && option("--name") !== skillName) throw new Error("UNKNOWN_SKILL");
    if (action === "source") {
      json({ ...await readJson(path.join(root, "capabilities.json")), package: pkg.name, version: pkg.version, name: skillName, sourcePath: source, skills: [{ ok: true, name: skillName, package: pkg.name, version: pkg.version, sourcePath: source }], complete: true });
    } else if (action === "status") {
      const target = selectedTarget(args);
      const receipt = await readJson(path.join(target, receiptName)).catch(() => null);
      const installed = await exists(path.join(target, "SKILL.md"));
      const actual = installed ? await digest(target) : undefined;
      const runtime = await readFile(path.join(target, ".runtime", "dist", "main.js")).catch(() => null);
      const runtimeCurrent = Boolean(runtime && receipt?.runtimeSha256 === createHash("sha256").update(runtime).digest("hex") && receipt.runtimeSha256 === createHash("sha256").update(await readFile(path.join(root, "dist", "main.js"))).digest("hex"));
      json({ name: skillName, package: pkg.name, edited: Boolean(installed && receipt && actual !== receipt.digest), verification: { verified: Boolean(actual && actual === receipt?.digest && runtimeCurrent), algorithm: "sha256" }, recovery: { required: false }, target, installed, managed: receipt?.package === owner, current: receipt?.package === owner && receipt.version === pkg.version && actual === receipt.digest && actual === await digest(source) && runtimeCurrent, version: receipt?.version ?? pkg.version, digest: actual, hostDiscovery: "pending" });
    } else if (["install", "update"].includes(action)) json(await installSkill(selectedTarget(args)));
    else throw new Error("UNKNOWN_SKILL_COMMAND");
  } else if (group === "update") {
    const tag = option("--channel") ?? "latest";
    if (!["latest", "next"].includes(tag)) throw new Error("INVALID_CHANNEL");
    const target = action === "install" ? selectedTarget(args) : undefined;
    if (action === "install" && await exists(path.join(root, "..", ".git"))) throw new Error("GIT_OWNED_INSTALL: update the checkout through Git.");
    const latest = await registry(tag);
    if (action === "check") json({ package: pkg.name, currentVersion: pkg.version, latestVersion: latest?.version ?? null, available: Boolean(latest && latest.version !== pkg.version), channel: tag, automaticInstall: false });
    else if (action === "install") {
      if (!latest || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(latest.version)) throw new Error("RELEASE_UNAVAILABLE");
      // npm only replaces a staged private bootstrap. The target-owned runtime is activated by its own installer.
      const stage = path.join(path.dirname(target!), `.tuda-update-${randomUUID()}`);
      await mkdir(stage);
      const npmEntry = process.platform === "win32" ? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js") : undefined;
      if (npmEntry && !await exists(npmEntry)) throw new Error("NPM_RUNTIME_REQUIRED: run this management operation with the installed Node.js runtime.");
      await promisify(execFile)(npmEntry ? process.execPath : "npm", [...(npmEntry ? [npmEntry] : []), "install", "--prefix", stage, "--ignore-scripts", "--no-audit", "--no-fund", `${owner}@${latest.version}`], { timeout: 180_000, windowsHide: true });
      const entry = path.join(stage, "node_modules", "@petercjl", "tuda", "dist", "main.js");
      const result = await promisify(execFile)(process.execPath, [entry, "skill", "update", "--target", target!, "--json"], { timeout: 60_000 });
      const receipt = JSON.parse(result.stdout);
      if (!receipt.ok || receipt.version !== latest.version || !receipt.current) throw new Error("SKILL_SYNC_INCOMPLETE");
      await rm(stage, { recursive: true, force: true });
      json({ ...receipt, package: owner, runtimeEntry: path.join(target!, ".runtime", "dist", "main.js"), bootstrapReplaced: false });
    } else throw new Error("UNKNOWN_UPDATE_COMMAND");
  }
  return true;
}
