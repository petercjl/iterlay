import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const load = async (file) => JSON.parse(await readFile(new URL(file, root), "utf8"));
const [brand, app, cli] = await Promise.all([load("shared/brand.json"), load("package.json"), load("cli/package.json")]);
const desktop = await load("desktop-package/package.json");
const checks = {
  productName: app.build.productName === brand.name,
  appId: app.build.appId === brand.appId,
  scheme: app.build.protocols[0].schemes[0] === brand.scheme,
  packageName: cli.name === brand.packageName,
  executable: Boolean(cli.bin[brand.cli]),
  desktopPackage: desktop.name === brand.desktopPackageName,
  desktopVersion: desktop.version === app.version
};
console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2));
if (Object.values(checks).some((pass) => !pass)) process.exitCode = 1;
