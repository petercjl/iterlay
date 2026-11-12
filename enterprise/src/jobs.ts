import { randomUUID } from "node:crypto";
import { BoardStore } from "../../electron/storage/board-store.js";
import { assertGenerateImageInput } from "../../shared/input-validation.js";
import { detectRemoteImageMime } from "../../electron/remote-image.js";
import type { GenerateImageInput, GenerateResponse, GenerationJob } from "../../shared/types.js";
import type { QueryResultRow } from "pg";
import type { Principal } from "./auth.js";
import { hash } from "./auth.js";
import { assetUrl, BoardTransaction } from "./boards.js";
import { AssetsService } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { fail } from "./config.js";
import { ProvidersService } from "./providers.js";
import { Database } from "./database.js";

export class JobsService {
  constructor(readonly db: Database, readonly config: ServerConfig, readonly assets: AssetsService, readonly providers: ProvidersService = new ProvidersService(db, config)) {}
  async submit(user: Principal, input: GenerateImageInput, requestId: string) {
    if (user.role === "viewer") fail(403, "READ_ONLY", "只读成员不能提交生成任务。");
    assertGenerateImageInput(input);
    if (input.n > 8 || input.outputNodeIds && (!Array.isArray(input.outputNodeIds) || input.outputNodeIds.length !== input.n || new Set(input.outputNodeIds).size !== input.n || input.outputNodeIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)))) fail(400, "INVALID_OUTPUT_IDENTITIES", "生成数量或输出节点标识无效。");
    if (input.resultTargetNodeId !== undefined && (typeof input.resultTargetNodeId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(input.resultTargetNodeId))) fail(400, "INVALID_TARGET", "编辑目标无效。");
    const account = await this.providers.resolve(user.orgId, user.id, "image");
    if (!account) fail(503, "IMAGE_PROVIDER_NOT_CONFIGURED", "管理员尚未配置企业图片服务。");
    if (input.model && input.model !== account.model) fail(400, "MODEL_UNSUPPORTED", "请选择管理员配置的企业图片模型。");
    if (input.sceneOnly || input.comicDramaContextSnapshot) fail(400, "WORKFLOW_UNSUPPORTED", "当前企业服务支持画板图片生成和参考图编辑。");
    if (!input.boardId) fail(400, "BOARD_REQUIRED", "企业生成任务必须指定画板。");
    for (const reference of input.referenceImages) {
      const bytes = Buffer.from(reference.dataBase64, "base64");
      if (bytes.length > 25 * 1024 * 1024 || detectRemoteImageMime(bytes) !== reference.mimeType) fail(400, "INVALID_REFERENCE", "参考图内容或格式无效。");
    }
    const fingerprint = hash(JSON.stringify(input));
    const id = /^[0-9a-f-]{36}$/i.test(input.clientTaskId ?? "") ? input.clientTaskId! : requestId;
    return this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.orgId]);
      const board = await client.query("SELECT id FROM tuda_boards WHERE org_id=$1 AND id=$2", [user.orgId, input.boardId]);
      if (!board.rowCount) fail(404, "BOARD_NOT_FOUND", "任务目标画板不存在。");
      const target = await new BoardTransaction(client, user.orgId).envelope(input.boardId!);
      if (input.resultTargetNodeId && !target?.board.nodes.some(node => node.id === input.resultTargetNodeId && "imagePath" in node)) fail(400, "INVALID_TARGET", "编辑目标不存在。");
      const prior = await client.query("SELECT * FROM tuda_jobs WHERE org_id=$1 AND id=$2", [user.orgId, id]);
      if (prior.rowCount) {
        if (prior.rows[0].request_hash !== fingerprint || prior.rows[0].user_id !== user.id) fail(409, "IDEMPOTENCY_CONFLICT", "任务标识已用于另一个请求。");
        return { taskId: id, status: prior.rows[0].status };
      }
      if (input.outputNodeIds?.some(id => target?.board.nodes.some(node => node.id === id && "imagePath" in node && Boolean(node.imagePath)))) fail(400, "OUTPUT_ID_CONFLICT", "输出节点标识已被使用，请重新发起。");
      await client.query("INSERT INTO tuda_jobs(org_id,id,user_id,request_hash,input,status,provider_secret) VALUES($1,$2,$3,$4,$5,'queued',$6)", [user.orgId, id, user.id, fingerprint, JSON.stringify(input), this.providers.seal(account, `${user.orgId}:${id}`)]);
      return { taskId: id, status: "queued" };
    });
  }
  async get(user: Principal, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail(400, "INVALID_TASK", "任务标识无效。");
    const query = await this.db.pool.query("SELECT id,status,result,error,created_at,input FROM tuda_jobs WHERE org_id=$1 AND id=$2", [user.orgId, id]);
    if (!query.rowCount) fail(404, "TASK_NOT_FOUND", "任务不存在。");
    return query.rows[0];
  }
  async list(user: Principal, boardId?: string) {
    const query = await this.db.pool.query("SELECT * FROM tuda_jobs WHERE org_id=$1 AND ($2::text IS NULL OR input->>'boardId'=$2) ORDER BY created_at DESC LIMIT 200", [user.orgId, boardId ?? null]);
    return query.rows.map(row => row.result?.job ?? this.history(row));
  }
  private history(row: QueryResultRow & {input: GenerateImageInput}): GenerationJob {
    const input = { ...row.input }; delete (input as Partial<GenerateImageInput>).referenceImages;
    return { id: row.id, status: row.status === "succeeded" ? "succeeded" : row.status === "queued" || row.status === "running" || row.status === "submitting" ? "running" : "failed",
      createdAt: new Date(row.created_at).toISOString(), completedAt: row.status === "succeeded" || row.status === "failed" ? new Date(row.updated_at ?? row.created_at).toISOString() : undefined,
      prompt: row.input.prompt, providerId: "enterprise-image", providerName: "企业图片服务", model: row.input.model,
      input, referenceImagePaths: [], outputImagePaths: [], boardId: row.input.boardId, error: row.error };
  }
  async cancel(user: Principal, id: string) {
    if (user.role === "viewer") fail(403, "READ_ONLY", "没有取消任务的权限。");
    const query = await this.db.pool.query("UPDATE tuda_jobs SET status='cancelled',updated_at=now() WHERE org_id=$1 AND id=$2 AND user_id=$3 AND status='queued' RETURNING id", [user.orgId, id, user.id]);
    return { status: query.rowCount ? "cancelled" : "running", remoteCancelled: false, message: query.rowCount ? "已取消尚未提交的任务。" : "任务可能已提交，未取消远端执行或费用。" };
  }
  async initializeWorker() {
    // Unknown provider outcomes never automatically resubmit paid work after a worker restart.
    await this.db.pool.query("UPDATE tuda_jobs SET status='unknown',error='工作进程中断，远端结果未确认；请核对服务商记录，系统不会自动重新提交。',updated_at=now() WHERE org_id=$1 AND status IN ('submitting','running')", [this.config.organizationId]);
  }
  async workOne(): Promise<boolean> {
    const job = await this.db.transaction(async client => {
      const query = await client.query("SELECT * FROM tuda_jobs WHERE org_id=$1 AND status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1", [this.config.organizationId]);
      if (!query.rowCount) return null;
      const row = query.rows[0];
      const member = await client.query("SELECT role,active FROM tuda_members WHERE org_id=$1 AND user_id=$2", [row.org_id, row.user_id]);
      if (!member.rows[0]?.active || member.rows[0].role === "viewer") {
        await client.query("UPDATE tuda_jobs SET status='failed',error='发起人的企业编辑权限已失效',updated_at=now() WHERE org_id=$1 AND id=$2", [row.org_id, row.id]);
        return null;
      }
      await client.query("UPDATE tuda_jobs SET status='submitting',updated_at=now() WHERE org_id=$1 AND id=$2", [row.org_id, row.id]);
      return row;
    });
    if (!job) return false;
    let providerReturned = false;
    try {
      const input = job.input as GenerateImageInput;
      const account = this.providers.unseal(job.provider_secret, `${job.org_id}:${job.id}`);
      const base = account.baseUrl.replace(/\/$/, "");
      const body = { model: account.model, prompt: input.prompt, n: input.n, size: input.size, quality: input.quality, style: input.style, background: input.background, output_format: input.outputFormat, response_format: "b64_json" };
      let payload: BodyInit = JSON.stringify(body), headers: Record<string, string> = { Authorization: `Bearer ${account.apiKey}`, "content-type": "application/json" };
      let endpoint = base + "/images/generations";
      if (input.referenceImages.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(body)) if (value !== undefined) form.set(key, String(value));
        for (const [index, reference] of input.referenceImages.entries()) {
          const bytes = Buffer.from(reference.dataBase64, "base64");
          if (bytes.length > 25 * 1024 * 1024) fail(400, "REFERENCE_TOO_LARGE", "参考图超过大小限制。");
          form.append(input.referenceImages.length > 1 ? "image[]" : "image", new Blob([bytes], { type: reference.mimeType }), reference.name || `reference-${index}.png`);
        }
        payload = form; headers = { Authorization: headers.Authorization }; endpoint = base + "/images/edits";
      }
      await this.db.pool.query("UPDATE tuda_jobs SET status='running',updated_at=now() WHERE org_id=$1 AND id=$2", [job.org_id, job.id]);
      const response = await fetch(endpoint, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok) { providerReturned = true; fail(502, "PROVIDER_FAILED", `企业图片服务返回错误（${response.status}）。`); }
      const result = await response.json() as { data?: Array<{ b64_json?: string; url?: string }> };
      providerReturned = true;
      if (!result.data?.length || result.data.length > 8) fail(502, "INVALID_PROVIDER_RESULT", "图片服务未返回有效结果。");
      const saved: Awaited<ReturnType<AssetsService["save"]>>[] = [];
      for (const image of result.data) {
        // Binary reference semantics stay with the original images; no textual reconstruction.
        if (!image.b64_json || image.b64_json.length > 36_000_000) fail(502, "PROVIDER_OUTPUT_UNSUPPORTED", "服务需返回 base64 图片；请核对任务结果，系统不会重新生成。");
        const bytes = Buffer.from(image.b64_json, "base64"), mime = detectRemoteImageMime(bytes);
        if (!mime) fail(502, "INVALID_PROVIDER_RESULT", "服务返回了无法识别的图片。");
        saved.push(await this.assets.save(job.org_id, bytes, mime));
      }
      await this.db.transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [job.org_id]);
        const tx = new BoardTransaction(client, job.org_id), store = new BoardStore("/enterprise", undefined, tx);
        const current = await store.getBoard(input.boardId!);
        if (!current) fail(409, "BOARD_REMOVED", "生成期间目标画板已删除，结果素材已保留。");
        const outputNodes = saved.map((asset, index) => ({ id: input.outputNodeIds?.[index] ?? randomUUID(), imagePath: asset.path, jobId: job.id, source: "generated" as const, width: asset.width, height: asset.height }));
        if (input.resultTargetNodeId) {
          if (!current.nodes.some(node => node.id === input.resultTargetNodeId && "imagePath" in node)) fail(409, "TARGET_REMOVED", "编辑目标已移除，结果素材已保留。");
          await store.appendVersions(input.boardId!, input.resultTargetNodeId, outputNodes);
        } else if (input.generationNodeId) {
          const finished = await store.finishGenerationNode(input.boardId!, input.generationNodeId, { jobId: job.id, nodes: outputNodes });
          if (!finished) await store.appendNodes(input.boardId!, outputNodes);
        } else {
          const byId = new Map(outputNodes.map(node => [node.id, node]));
          if (current.nodes.some(node => byId.has(node.id))) await store.saveBoard({ id: current.id, expectedRevision: current.revision, nodes: current.nodes.map(node => byId.has(node.id) ? { ...node, ...byId.get(node.id) } : node) });
          await store.appendNodes(input.boardId!, outputNodes.filter(node => !current.nodes.some(existing => existing.id === node.id)));
        }
        const history = { ...this.history({ ...job, status: "succeeded", updated_at: new Date() }), outputImagePaths: saved.map(asset => asset.path) };
        const output: GenerateResponse = { job: history, images: saved.map(asset => ({ path: asset.path, dataUrl: assetUrl(asset.path) })) };
        await client.query("UPDATE tuda_jobs SET status='succeeded',result=$3,updated_at=now() WHERE org_id=$1 AND id=$2", [job.org_id, job.id, JSON.stringify(output)]);
        // API servers discover changes committed by the independent worker through LISTEN/NOTIFY.
        await client.query("SELECT pg_notify('tuda_changes',$1)", [JSON.stringify({ orgId: job.org_id, boardIds: tx.events.map(event => event.boardId) })]);
      });
    } catch (error) {
      await this.db.pool.query("UPDATE tuda_jobs SET status=$3,error=$4,updated_at=now() WHERE org_id=$1 AND id=$2", [job.org_id, job.id, providerReturned ? "failed" : "unknown",
        providerReturned && error instanceof Error ? error.message.slice(0, 300) : "远端提交结果未确认；请核对服务商记录，系统不会自动重复生成。"]);
    }
    return true;
  }
}
