import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { Client } from "../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-plugin-stdio-"));
const calls = [];
let token = "t".repeat(43);
const instanceId = () => createHash("sha256").update(`${backend.address().port}\0${token}`).digest("hex");
const backend = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer " + token);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ route: req.url, body });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ result: { protocolVersion: 1, accepted: true } }));
});
await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("cli/dist/board-plugin.js")],
  env: { ...process.env, TUDA_USER_DATA_PATH: directory, TUDA_NO_LAUNCH: "1", TUDA_PLUGIN_SPACE: "enterprise", TUDA_AUTH_HANDOFF_FILE: path.join(directory, "not-issued-yet.json") }, stderr: "pipe" });
let diagnostics = "";
transport.stderr?.on("data", chunk => { diagnostics += chunk; });
const client = new Client({ name: "generic-plugin-consumer", version: "1.0.0" });
try {
  await writeFile(path.join(directory, "local-api.json"), JSON.stringify({ port: backend.address().port, token }), { flag: "wx", mode: 0o600 });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some(t => t.name === "write_board_text"));
  assert(!tools.some(t => /generate|provider|canvas/.test(t.name)));
  assert.equal(calls.length, 0, "discovery must not start desktop or authenticate");
  const denied = await client.callTool({ name: "generate_image", arguments: { prompt: "must not execute" } });
  assert.equal(denied.isError, true);
  assert.equal(calls.length, 0);
  const wrongSpace = await client.callTool({ name: "list_boards", arguments: { space: "personal" } });
  assert.equal(wrongSpace.isError, true);
  assert.equal(calls.length, 0);
  // The host issues its short-lived private file immediately before the first business call.
  const prepared = await promisify(execFile)(process.execPath, [path.resolve("cli/dist/main.js"), "desktop", "prepare", "--user-data-path", directory, "--no-launch", "--json"]);
  assert.deepEqual(JSON.parse(prepared.stdout).data, { ready: true, instanceId: instanceId(), protocolVersion: 1 });
  const grant = { instanceId: instanceId(), contract: 1, origin: "https://company.example.test", appId: "tuda", code: "c".repeat(43), verifier: "v".repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() };
  await writeFile(path.join(directory, "not-issued-yet.json"), JSON.stringify(grant), { mode: 0o600, flag: "wx" });
  const image = path.join(directory, "生成结果.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=", "base64"), { flag: "wx" });
  const result = await client.callTool({ name: "import_board_images", arguments: { boardId: "board", operationId: "import-1", files: [image] } });
  assert(!result.isError, JSON.stringify(result));
  const operation = calls.find(c => c.route === "/board-plugin/call");
  assert.equal(operation.body.args.space, "enterprise");
  assert.equal(operation.body.args.files, undefined);
  assert(operation.body.args.images[0].startsWith("data:image/png;base64,"));
  assert.equal(calls.filter(c => c.route === "/board-plugin/auth").length, 1);
  await client.callTool({ name: "list_boards", arguments: {} });
  assert.equal(calls.filter(c => c.route === "/board-plugin/auth").length, 1, "do not replay one-time grants");
  token = "u".repeat(43);
  await writeFile(path.join(directory, "local-api.json"), JSON.stringify({ port: backend.address().port, token }), { mode: 0o600 });
  const stale = await client.callTool({ name: "list_boards", arguments: {} });
  assert(stale.isError && JSON.stringify(stale).includes("AUTH_HANDOFF_STALE_INSTANCE"));
  await writeFile(path.join(directory, "not-issued-yet.json"), JSON.stringify({ ...grant, code: "d".repeat(43), instanceId: instanceId() }), { mode: 0o600 });
  assert(!(await client.callTool({ name: "list_boards", arguments: {} })).isError);
  assert.equal(calls.filter(c => c.route === "/board-plugin/auth").length, 2, "new desktop instance requires a fresh handoff");
  assert(!JSON.stringify(result).includes(grant.code));
  assert(!diagnostics.includes(grant.verifier));
  console.log(JSON.stringify({ ok: true, tools: tools.length, discoveryOffline: true, generationDenied: true, fixedSpace: true, delayedPrivateAuth: true, localImageImport: true }));
} finally {
  await client.close();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
