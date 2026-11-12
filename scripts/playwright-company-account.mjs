import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "output/playwright"), { recursive: true });
const output = await mkdtemp(
  path.join(root, "output/playwright/company-account-"),
);
const userData = await mkdtemp(path.join(os.tmpdir(), "tuda-company-account-"));
const folder = path.join(userData, "selected-company-folder");
await mkdir(folder);
await mkdir(path.join(userData, "workspace"));
await writeFile(
  path.join(userData, "workspace/settings.json"),
  JSON.stringify({
    providers: [],
    activeProviderId: "",
    textProviders: [],
    activeTextProviderId: "",
    theme: "dark",
    language: "zh-CN",
    memoryEnabled: false,
  }),
);
const fixture = await readFile(path.join(root, "demo-assets/lamp-studio.jpg"));
const identity = {
  contract: 1,
  appId: "tuda",
  sessionId: "fixture-device",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  member: { id: "fixture-employee", name: "模拟员工" },
  organization: { id: "fixture-company", name: "模拟公司" },
};
let origin;
let modelCalls = 0;
const requests = [];
let verified = false;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const b of req) raw += b;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ route: req.url, app: req.headers["x-company-app-id"] });
  const send = (data, status = 200) =>
    res
      .writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify({ ok: true, data }));
  const id = "a".repeat(43);
  if (req.url.endsWith("/auth/start"))
    return send({
      contract: 1,
      appId: "tuda",
      requestId: id,
      userCode: "AAAAAAAA",
      expiresIn: 600,
      intervalMs: 2000,
      verificationUrl: origin + "/api/company/v1/auth/authorize?request=" + id,
    });
  if (req.url.endsWith("/auth/poll")) {
    assert.match(body.verifier, /^[\w-]{43}$/);
    verified = true;
    return send({
      ...identity,
      status: "authorized",
      token: "fixture-private-device-token",
    });
  }
  assert.equal(
    req.headers.authorization,
    "Bearer fixture-private-device-token",
  );
  assert.equal(req.headers["x-company-app-id"], "tuda");
  if (req.url.endsWith("/session"))
    return send({ ...identity, authenticated: true });
  if (req.url.endsWith("/bootstrap"))
    return send({
      ...identity,
      configVersion: "fixture-v1",
      text: {
        enabled: true,
        defaultModel: "responses/fixture-model",
        providers: ["responses", "anthropic", "chat"].map((id, i) => ({
          id,
          name: id,
          protocol: [
            "openai-responses",
            "anthropic-messages",
            "openai-chat-completions",
          ][i],
          baseUrl: origin + "/api/company/v1/proxy/tuda/" + id + "/v1",
          models: [{ id: "fixture-model", name: "模拟文本 " + id }],
        })),
      },
      image: {
        enabled: true,
        adapter: "toapiscli",
        package: "@petercjl/toapiscli",
        credential: {
          schemaVersion: 1,
          site: "cn",
          apiKey: "fixture-private-image-key",
        },
        models: ["gpt-image-2.6-sunburst"],
      },
      storage: { enabled: false, reason: "STORAGE_NOT_CONFIGURED" },
    });
  if (req.url.includes("/proxy/")) {
    modelCalls++;
    const text = JSON.stringify({
      text: "完成检查",
      toolCalls: [
        {
          name: "finish_assistant_result",
          arguments: {
            result: {
              message: "已用公司模型检查画板",
              intent: "chat",
              goal: "explain",
              commitment: "advise_only",
              fields: [],
            },
          },
        },
      ],
    });
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      }),
    );
  }
  if (req.url.endsWith("/logout"))
    return send({ contract: 1, appId: "tuda", revoked: true });
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = `http://127.0.0.1:${server.address().port}`;
let desktop;
try {
  const env = {
    ...process.env,
    TUDA_PLAYWRIGHT: "1",
    TUDA_E2E_USER_DATA: userData,
    TUDA_COMPANY_URL: origin,
  };
  delete env.VITE_DEV_SERVER_URL;
  delete env.TUDA_ENTERPRISE_URL;
  desktop = await electron.launch({
    args: ["."],
    cwd: root,
    env,
    executablePath: process.env.TUDA_E2E_ELECTRON,
    timeout: 60_000,
  });
  const bundledToapis = await desktop.evaluate(
    async ({ dialog, shell }, { folder, module, fixture }) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
      shell.openExternal = async () => undefined;
      const file = process.getBuiltinModule("url").fileURLToPath(module);
      const require = process.getBuiltinModule("module").createRequire(file);
      const { CompanyToapis } = require(file);
      CompanyToapis.prototype.testConnection = async () => undefined;
      const entry = process
        .getBuiltinModule("path")
        .join(
          process
            .getBuiltinModule("path")
            .dirname(require.resolve("@petercjl/toapiscli/package.json")),
          "bin/toapiscli.mjs",
        );
      const capability = JSON.parse(
        process
          .getBuiltinModule("child_process")
          .execFileSync(process.execPath, [entry, "capabilities", "--json"], {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              TOAPISCLI_UPDATE_CHECK: "0",
              TOAPISCLI_AUTO_UPDATE: "0",
            },
            encoding: "utf8",
          }),
      );
      CompanyToapis.prototype.generate = async function (input) {
        if (input.model !== "gpt-image-2.6-sunburst")
          throw Error("wrong model");
        return {
          images: [
            { bytes: Buffer.from(fixture, "base64"), mimeType: "image/jpeg" },
          ],
        };
      };
      return capability.version;
    },
    {
      folder,
      module: pathToFileURL(
        path.join(root, "dist-electron/electron/company/toapis.js"),
      ).href,
      fixture: fixture.toString("base64"),
    },
  );
  assert.equal(bundledToapis, "0.1.1");
  const page = await desktop.firstWindow();
  const failures = [];
  page.on("pageerror", (e) => failures.push(e.message));
  await page.waitForFunction(
    () =>
      window.imageWorkbench && document.documentElement.dataset.boardSaveState,
    { timeout: 60_000 },
  );
  await page.evaluate(() => window.imageWorkbench.beginEnterpriseLogin());
  await page.waitForTimeout(2100);
  await page.evaluate(() => window.imageWorkbench.pollEnterpriseLogin());
  await page.waitForFunction(
    async () => {
      try {
        return (
          (await window.imageWorkbench.enterpriseStatus()).activeSpace ===
          "enterprise"
        );
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  await page.waitForTimeout(700);
  const status = await page.evaluate(() =>
    window.imageWorkbench.enterpriseStatus(),
  );
  assert.equal(status.textModels, 3);
  assert.equal(status.imageModels, 1);
  assert.equal(status.storageKind, "local");
  assert(verified);
  const settings = await page.evaluate(() =>
    window.imageWorkbench.getSettings(),
  );
  assert.equal(settings.textProviders.length, 3);
  assert.equal(settings.providers[0].transport, "toapiscli");
  assert.equal(JSON.stringify(settings).includes("fixture-private"), false);
  const board = await page.evaluate(() =>
    window.imageWorkbench.createBoard("公司离线存储验证"),
  );
  const result = await page.evaluate(() =>
    window.imageWorkbench.collaborateScene({
      instruction: "解释当前画板",
      referenceImages: [],
      currentFields: [],
      workflowMode: "generate",
      assistantSurface: "canvas-prompt",
      agentMode: true,
    }),
  );
  assert.equal(result.message, "已用公司模型检查画板");
  assert(modelCalls > 0);
  const generated = await page.evaluate(
    (boardId) =>
      window.imageWorkbench.generateImage({
        boardId,
        workflowMode: "generate",
        prompt: "模拟生成，不调用真实模型",
        model: "gpt-image-2.6-sunburst",
        size: "auto",
        n: 1,
        referenceImages: [],
      }),
    board.id,
  );
  assert.equal(generated.images.length, 1);
  assert(generated.images[0].path.startsWith(folder));
  await page.evaluate(
    ({ id, image, jobId }) =>
      window.imageWorkbench.appendBoardNodes(id, [
        { id: "fixture-image", imagePath: image, jobId, source: "generated" },
      ]),
    { id: board.id, image: generated.images[0].path, jobId: generated.job.id },
  );
  const imageReadable = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return response.ok && (await response.blob()).size > 0;
  }, generated.images[0].dataUrl);
  assert(imageReadable);
  await page.screenshot({ path: path.join(output, "company-local.png") });
  await page.evaluate(() => window.imageWorkbench.selectSpace("personal"));
  await page.waitForTimeout(700);
  const personal = await page.evaluate(() =>
    window.imageWorkbench.listBoards(),
  );
  assert(!personal.some((b) => b.id === board.id));
  assert.equal(
    (await page.evaluate(() => window.imageWorkbench.getSettings()))
      .textProviders.length,
    3,
    "Model access follows the account across spaces",
  );
  await page.evaluate(() => window.imageWorkbench.selectSpace("enterprise"));
  await page.waitForTimeout(700);
  const saved = await page.evaluate(
    (id) => window.imageWorkbench.getBoard(id),
    board.id,
  );
  assert(saved.nodes.some((n) => n.id === "fixture-image"));
  const session = await readFile(
    path.join(userData, "company-session.json"),
    "utf8",
  );
  assert(!session.includes("fixture-private"));
  assert.equal(
    requests.some((r) => r.route.includes("storage/token")),
    false,
    "Local company storage must not contact NAS or request storage grants",
  );
  assert.equal(failures.length, 0, JSON.stringify(failures));
  const authorizationCount = requests.filter((r) =>
    r.route.endsWith("/auth/poll"),
  ).length;
  await desktop.close();
  desktop = await electron.launch({
    args: ["."],
    cwd: root,
    env,
    executablePath: process.env.TUDA_E2E_ELECTRON,
    timeout: 60_000,
  });
  await desktop.evaluate(
    ({app}, module) => {
      if(app.isPackaged)throw new Error("Fixture requires unpackaged app");
      const file = process.getBuiltinModule("url").fileURLToPath(module);
      process.getBuiltinModule("module").createRequire(file)(
        file,
      ).CompanyToapis.prototype.testConnection = async () => undefined;
    },
    pathToFileURL(path.join(root, "dist-electron/electron/company/toapis.js"))
      .href,
  );
  const reopened = await desktop.firstWindow();
  await reopened.waitForFunction(
    () =>
      window.imageWorkbench && document.documentElement.dataset.boardSaveState,
    { timeout: 60_000 },
  );
  assert.equal(
    (await reopened.evaluate(() => window.imageWorkbench.enterpriseStatus()))
      .authenticated,
    true,
  );
  assert(
    (
      await reopened.evaluate(
        (id) => window.imageWorkbench.getBoard(id),
        board.id,
      )
    ).nodes.some((n) => n.id === "fixture-image"),
  );
  assert.equal(
    requests.filter((r) => r.route.endsWith("/auth/poll")).length,
    authorizationCount,
    "Restart restores the encrypted device session without a new login",
  );
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        ok: true,
        mode: "offline-fixture",
        textModels: 3,
        imageModels: 1,
        agent: true,
        generation: true,
        assetRead: true,
        personalIsolation: true,
        encryptedSession: true,
        restartRestoration: true,
        bundledToapis,
        requests: requests.map((r) => r.route),
        userData,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      output,
      userData,
      companyFolder: folder,
      modelCalls,
    }),
  );
} finally {
  await desktop?.close();
  await new Promise((r) => server.close(r));
}
