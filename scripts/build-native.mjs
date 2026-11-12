import { execFileSync } from "node:child_process";
if (process.platform === "darwin") execFileSync("bash", ["scripts/build-photo-layer-segmenter.sh"], { stdio: "inherit" });
else console.log("Native macOS helpers are not required on this platform.");
