import { compareVersions, parseVersion, type UpdateManifest, type UpdatePlatform } from "./app-update.js";

export const DESKTOP_PATCH_BASELINE = "0.1.9";
// electron-builder embeds the application version in each macOS helper's sealed plist.
const macVersionedHelpers = ["Tuda Helper", "Tuda Helper (GPU)", "Tuda Helper (Plugin)", "Tuda Helper (Renderer)"];
export const desktopPatchPaths: Readonly<Record<UpdatePlatform, readonly string[]>> = {
  darwin: [
    "Contents/Info.plist", "Contents/MacOS/Tuda", "Contents/Resources/app.asar", "Contents/_CodeSignature/CodeResources",
    ...macVersionedHelpers.flatMap(name => {
      const contents = `Contents/Frameworks/${name}.app/Contents`;
      return [`${contents}/Info.plist`, `${contents}/MacOS/${name}`];
    }),
  ],
  win32: ["Tuda.exe", "resources/app.asar"],
};

export function validDesktopPatch(manifest: UpdateManifest): boolean {
  const patch = manifest.patch;
  if (!patch || typeof patch.baseVersion !== "string" || !parseVersion(patch.baseVersion) || !parseVersion(manifest.version)
    || compareVersions(patch.baseVersion, DESKTOP_PATCH_BASELINE) < 0 || compareVersions(manifest.version, patch.baseVersion) <= 0
    || !Array.isArray(patch.files) || !patch.files.length) return false;
  const paths = desktopPatchPaths[manifest.platform];
  const names = new Set<string>();
  if (!paths || patch.files.length > paths.length) return false;
  let transferred = 0;
  for (const file of patch.files) {
    if (!file || !paths.includes(file.path) || names.has(file.path)
      || typeof file.baseSha256 !== "string" || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.baseSha256) || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || file.baseSha256 === file.sha256 || !Number.isSafeInteger(file.fileSize) || file.fileSize <= 0
      || !Array.isArray(file.ranges) || file.ranges.length > 16384) return false;
    let end = 0;
    for (const range of file.ranges) {
      if (!range || !Number.isSafeInteger(range.offset) || range.offset < end
        || !Number.isSafeInteger(range.size) || range.size <= 0 || range.size > file.fileSize - range.offset) return false;
      end = range.offset + range.size;
      transferred += range.size;
    }
    names.add(file.path);
  }
  const asar = manifest.platform === "darwin" ? "Contents/Resources/app.asar" : "resources/app.asar";
  const identity = manifest.platform === "darwin" ? "Contents/Info.plist" : "Tuda.exe";
  return names.has(asar) && names.has(identity) && Number.isSafeInteger(transferred) && transferred > 0 && transferred === manifest.fileSize;
}
