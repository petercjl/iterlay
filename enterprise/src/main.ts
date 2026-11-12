import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "./config.js";
import { Database } from "./database.js";
import { JobsService } from "./jobs.js";
import { AssetsService } from "./assets.js";
import { createEnterpriseServer } from "./server.js";
async function main() {
  const config = readConfig();
  if (process.argv.includes("--worker")) {
    const db = new Database(config.databaseUrl); await db.initialize();
    const lock = await db.pool.connect();
    const acquired = await lock.query("SELECT pg_try_advisory_lock(851438) AS locked");
    if (!acquired.rows[0].locked) throw new Error("An enterprise media worker is already running.");
    const jobs = new JobsService(db, config, new AssetsService(db, config)); await jobs.initializeWorker();
    let stop = false; process.on("SIGTERM", () => { stop = true; }); process.on("SIGINT", () => { stop = true; });
    while (!stop) { if (!await jobs.workOne()) await delay(500); }
    lock.release(); await db.close();
  } else {
    const service = await createEnterpriseServer(config); const address = await service.listen();
    console.log("Tuda enterprise server listening", typeof address === "object" ? address?.port : address);
    const stop = () => void service.close().then(() => process.exit(0)); process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Enterprise startup failed"); process.exitCode = 1; });
