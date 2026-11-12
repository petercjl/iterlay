import { spawn } from "node:child_process";
import { prepareDevElectron } from "./prepare-dev-electron.mjs";

const executable = await prepareDevElectron();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, process.argv.slice(2).length ? process.argv.slice(2) : ["."], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
