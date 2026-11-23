import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "tuda-model-sync-"));
const requests = [];
let app;
let company;
let provider;
try {
  const cert = path.join(fixtureRoot, "cert.pem"), key = path.join(fixtureRoot, "cert-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const jpeg = await readFile(path.join(root, "demo-assets/lamp-studio.jpg"));
  const video = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=size=160x90:rate=24",
    "-t", "1", "-c:v", "libx264", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "-"]);
  const audio = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "0.4", "-f", "mp3", "-"]);
  const media = (res, type, data) => res.writeHead(200, { "content-type": type }).end(data);
  const json = (res, data, status = 200) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data));
  const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const body = async req => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const raw = Buffer.concat(parts).toString();
    return req.headers["content-type"]?.includes("application/json") && raw ? JSON.parse(raw) : {};
  };
  let providerOrigin;
  const failures = [];
  provider = createHttpsServer({ cert: await readFile(cert), key: await readFile(key) }, async (req, res) => {
    try {
      const input = await body(req);
      if (req.url === "/result.mp4") return media(res, "video/mp4", video);
      const [route, kind, rank] = req.url.match(/^\/(text|image|video|audio)-(a|b)(?=\/)/u) ?? [];
      assert(route);
      const expected = `Bearer fixture-${kind}-${rank}`;
      assert.equal(req.headers.authorization, expected);
      assert.equal(req.headers["x-company-app-id"], undefined);
      requests.push({ kind, rank, path: req.url, method: req.method, model: input.model });
      if (req.method === "POST" && rank === "a") return json(res, { error: { message: "fixture quota" } }, 429);
      if (kind === "text") {
        const content = "同步验收通过";
        const result = { message: content, intent: "chat", goal: "explain", commitment: "advise_only", fields: [] };
        const decision = JSON.stringify({ text: content, toolCalls: [{ name: "finish_assistant_result", arguments: { result } }] });
        if (!input.stream) return json(res, { choices: [{ message: { role: "assistant", content: decision } }] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = { id: "fixture", object: "chat.completion.chunk", model: "text-b",
          created: 1, choices: [{ index: 0, delta: { role: "assistant", content: decision }, finish_reason: null }] };
        const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
        return res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
      }
      if (kind === "image") return json(res, { data: [{ b64_json: jpeg.toString("base64") }] });
      if (kind === "video") {
        if (req.method === "POST") return json(res, { id: "fixture-video", status: "queued" });
        return json(res, { id: "fixture-video", status: "completed", result: { data: [{ url: providerOrigin + "/result.mp4" }] } });
      }
      if (kind === "audio") return media(res, "audio/mpeg", audio);
      return json(res, {}, 404);
    } catch (error) { failures.push(error.message); json(res, {}, 500); }
  });
  await listen(provider);
  providerOrigin = `https://127.0.0.1:${provider.address().port}`;
  const kinds = { text: "openai-chat-completions", image: "images", video: "seedance-toapis", audio: "openai-speech" };
  const labels = { text: "模拟文本", image: "模拟图片", video: "模拟视频", audio: "模拟音频" };
  let version = "published-1", reverse = false, empty = false;
  let modelReads = 0, companyOrigin;
  const identity = { contract: 1, appId: "tuda", sessionId: "fixture-session",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    member: { id: "member", name: "同步验收员工" }, organization: { id: "organization", name: "模拟企业" } };
  company = createServer(async (req, res) => {
    const send = data => json(res, { ok: true, data });
    await body(req);
    if (req.url.endsWith("/auth/start")) {
      const id = "a".repeat(43);
      return send({ contract: 1, appId: "tuda", requestId: id, userCode: "AAAAAAAA", expiresIn: 600,
        intervalMs: 2000, verificationUrl: companyOrigin + "/api/company/v1/auth/authorize?request=" + id });
    }
    if (req.url.endsWith("/auth/poll")) return send({ ...identity, status: "authorized", token: "fixture-company-device" });
    if (req.headers.authorization !== "Bearer fixture-company-device" || req.headers["x-company-app-id"] !== "tuda")
      return json(res, { ok: false }, 401);
    if (req.url.endsWith("/session")) return send({ ...identity, authenticated: true, managedModelsVersion: version });
    if (req.url.endsWith("/bootstrap")) return send({ ...identity, configVersion: version,
      text: { enabled: false, defaultModel: null, providers: [] }, image: { enabled: false, models: [] },
      storage: { enabled: false, reason: "STORAGE_NOT_CONFIGURED" } });
    if (req.url.endsWith("/managed-models")) {
      modelReads++;
      const models = Object.fromEntries(Object.entries(kinds).map(([kind, adapter]) => [kind,
        empty ? { defaultModelId: null, items: [] } : { defaultModelId: kind, items: [{ id: kind, name: labels[kind],
          channels: (reverse ? ["b", "a"] : ["a", "b"]).map(rank => ({
            id: `${kind}-${rank}`, name: `隐藏渠道 ${rank}`, adapter, apiKey: `fixture-${kind}-${rank}`,
            baseUrl: `${providerOrigin}/${kind}-${rank}/v1`, model: `${kind}-${rank}`
          })) }] }]));
      return send({ contract: 1, appId: "tuda", sessionId: identity.sessionId, memberId: identity.member.id,
        organizationId: identity.organization.id, configVersion: version, models });
    }
    if (req.url.endsWith("/logout")) return send({ contract: 1, appId: "tuda", revoked: true });
    return json(res, { ok: false }, 404);
  });
  await listen(company);
  companyOrigin = `http://127.0.0.1:${company.address().port}`;
  app = await electron.launch({
    cwd: root, args: ["."], executablePath: process.env.TUDA_E2E_ELECTRON,
    env: { ...process.env, TUDA_PLAYWRIGHT: "1", TUDA_E2E_USER_DATA: path.join(fixtureRoot, "user-data"),
      TUDA_OMNI_URL: companyOrigin, NODE_EXTRA_CA_CERTS: cert, VITE_DEV_SERVER_URL: "http://127.0.0.1:5180" },
    timeout: 60_000
  });
  app.process().stderr?.on("data", data => process.stderr.write(data));
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "前往山海授权登录" }).waitFor({ timeout: 60_000 });
  await app.evaluate(({ shell }) => { shell.openExternal = async () => undefined; return true; });
  await page.evaluate(() => window.imageWorkbench.beginEnterpriseLogin());
  await page.waitForTimeout(2050);
  await page.evaluate(() => window.imageWorkbench.pollEnterpriseLogin());
  await page.waitForFunction(async () => (await window.imageWorkbench.getSettings()).companyModelRouting?.text.defaultModel === "模拟文本");
  const settings = await page.evaluate(() => window.imageWorkbench.getSettings());
  assert.equal(JSON.stringify(settings).includes("fixture-company-device"), false);
  assert.equal(JSON.stringify(settings).includes("隐藏渠道"), false);
  assert.equal(JSON.stringify(settings).includes(providerOrigin), false);
  assert.equal(JSON.stringify(settings).includes("fixture-text-a"), false);
  for (const [kind, name] of Object.entries(labels)) assert.equal(settings.companyModelRouting[kind].defaultModel, name);
  console.log("登录自动下发四类模型，渲染器配置无密钥和连接地址");

  const board = await page.evaluate(() => window.imageWorkbench.createBoard("企业模型同步验收"));
  try {
    const result = await page.evaluate(() => window.imageWorkbench.collaborateScene({ instruction: "回答同步验收", referenceImages: [],
      currentFields: [], workflowMode: "generate", assistantSurface: "canvas-prompt", agentMode: true }));
    assert.equal(result.message, "同步验收通过");
  } catch (error) {
    console.error("模拟文本响应失败", error.message, { requests, failures });
    throw error;
  }
  const image = await page.evaluate(async boardId => {
    const api = window.imageWorkbench;
    await api.appendBoardNodes(boardId, [{ id: "image-node", type: "generation", title: "图片", x: 0, y: 0 }]);
    return api.generateImage({ boardId, generationNodeId: "image-node", workflowMode: "generate",
      useImageRouting: true, prompt: "模拟图片生成", model: "模拟图片", size: "auto", n: 1, referenceImages: [] });
  }, board.id);
  assert(image.images.length);
  const job = await page.evaluate(async boardId => {
    const api = window.imageWorkbench;
    await api.appendBoardNodes(boardId, [{ id: "video-node", type: "video-generation", title: "视频", x: 0, y: 0 }]);
    return api.startVideoGeneration({ boardId, generationNodeId: "video-node", prompt: "模拟视频生成", model: "模拟视频",
      useVideoRouting: true, durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", referenceImagePaths: [] });
  }, board.id);
  await page.waitForFunction(async id => (await window.imageWorkbench.getVideoJob(id))?.status === "completed", job.id);
  const speech = await page.evaluate(() => window.imageWorkbench.synthesizeAudio({ text: "同步验收" }));
  assert.equal(speech.mimeType, "audio/mpeg");
  assert((await readFile(speech.path)).length);
  for (const kind of Object.keys(kinds)) {
    const attempts = requests.filter(request => request.kind === kind && request.method === "POST");
    assert.equal(attempts[0]?.rank, "a", kind);
    assert(attempts.some(attempt => attempt.rank === "b"), kind);
  }
  console.log("文本、图片、视频、音频均验证 A 渠道明确拒绝后转 B");

  await page.locator("[data-global-account]").first().click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  const before = modelReads;
  version = "published-2";
  reverse = true;
  await page.getByRole("button", { name: "同步模型配置", exact: true }).click();
  await page.getByText("模型配置已同步。", { exact: true }).waitFor();
  assert(modelReads > before);
  await page.evaluate(() => window.imageWorkbench.synthesizeAudio({ text: "重新同步后的渠道顺序" }));
  assert.equal(requests.filter(request => request.kind === "audio").at(-1).rank, "b");
  version = "published-3";
  empty = true;
  await page.getByRole("button", { name: "同步模型配置", exact: true }).click();
  await page.getByText("模型配置已同步。", { exact: true }).waitFor();
  const revoked = await page.evaluate(() => window.imageWorkbench.getSettings());
  assert(Object.values(revoked.companyModelRouting).every(selected => !selected.models.length));
  assert.equal(failures.length, 0, JSON.stringify(failures));
  console.log("真实 Dev 按钮完成重新排序和空配置撤销");
} finally {
  await app?.close();
  company?.closeAllConnections();
  company?.close();
  provider?.closeAllConnections();
  provider?.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
