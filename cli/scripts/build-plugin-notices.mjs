import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const meta = JSON.parse(await readFile(path.join(root, "dist/board-plugin.meta.json"), "utf8"));
const packages = new Map();
for (const file of Object.keys(meta.inputs).filter(file => file.includes("node_modules/"))) {
  let directory = path.dirname(path.resolve(root, file));
  while (directory !== path.dirname(directory)) {
    const pkg = await readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch(() => null);
    if (pkg?.name && pkg?.version) { packages.set(pkg.name + "@" + pkg.version, directory); break; }
    directory = path.dirname(directory);
  }
}
const sections = [];
for (const [name, directory] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const files = (await readdir(directory)).filter(file => /^(licen[cs]e|copying)(\..*)?$/i.test(file));
  if (!files.length) throw new Error(`Bundled dependency license missing: ${name}`);
  sections.push(name + "\n" + (await Promise.all(files.sort().map(file => readFile(path.join(directory, file), "utf8")))).join("\n"));
}
await writeFile(path.join(root, "dist/board-plugin.LICENSES.txt"), sections.join("\n\n----------------------------------------\n\n") + "\n");
