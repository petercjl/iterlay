import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const source = process.cwd();
describe("independent release artifacts", () => {
  it("prepares and packs desktop metadata without touching plugin identity or contents", () => {
    const root = mkdtempSync(path.join(tmpdir(), "tuda-release-contract-"));
    try {
      for (const name of ["cli", "desktop-package", "release"]) mkdirSync(path.join(root, name));
      const put = (file: string, value: unknown) => writeFileSync(path.join(root, file), JSON.stringify(value));
      put("package.json", {version:"8.2.0"});
      put("cli/package.json", {name:"@petercjl/tuda",version:"1.7.4"});
      const before = readFileSync(path.join(root,"cli/package.json"));
      put("desktop-package/package.json", {name:"@petercjl/tuda-desktop",version:"8.2.0",repository:{type:"git",url:"https://github.com/petercjl/iterlay.git"}});
      put("desktop-package/release-manifest.json", {schemaVersion:1,applicationVersion:"8.2.0",installers:[]});
      copyFileSync(path.join(source,"desktop-package/validate.mjs"),path.join(root,"desktop-package/validate.mjs"));
      // Synthetic bytes test metadata integrity only, never native installer acceptance.
      const bytes = Buffer.alloc(1_000_001, 7); bytes.write("MZ");
      writeFileSync(path.join(root,"release/Tuda-8.2.0-x64.exe"), bytes);
      execFileSync(process.execPath,[path.join(source,"scripts/prepare-release-manifest.mjs"),"--arch","x64"],{cwd:root});
      expect(readFileSync(path.join(root,"cli/package.json"))).toEqual(before);
      execFileSync(process.execPath,[path.join(root,"desktop-package/validate.mjs")],{cwd:root});
      const desktop = JSON.parse(readFileSync(path.join(root,"desktop-package/package.json"),"utf8"));
      expect(desktop.tudaRelease.applicationVersion).toBe("8.2.0");
      expect(desktop.tudaRelease.installers[0].npmPayloads[0].url).toContain("/@petercjl/tuda-desktop/-/tuda-desktop-");
      desktop.version = "8.2.1"; put("desktop-package/package.json",desktop);
      expect(() => execFileSync(process.execPath,[path.join(root,"desktop-package/validate.mjs")],{cwd:root,stdio:"pipe"})).toThrow();
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
});
