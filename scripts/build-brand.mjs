import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = path.join(root, "resources/branding/tuda-master.svg");
const png = path.join(root, "resources/branding/tuda-master.png");
execFileSync("magick", ["-background", "none", svg, png]);
for (const name of ["build/icon.png", "src/assets/app-icon-default.png", "src/assets/app-icon-mascot.png", "resources/app-icons/tuda-default.png", "resources/app-icons/tuda-mascot.png"]) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await copyFile(png, path.join(root, name));
}
execFileSync("magick", [png, "-define", "icon:auto-resize=256,128,64,48,32,24,16", path.join(root, "build/icon.ico")]);
const iconset = path.join(root, "build/icon.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync("magick", [png, "-resize", `${size * scale}x${size * scale}`, path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
  }
}
if (process.platform === "darwin") execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(root, "build/icon.icns")]);
console.log("Tuda brand assets generated from resources/branding/tuda-master.svg");
