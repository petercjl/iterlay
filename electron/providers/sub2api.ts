import type {
  GenerationResult,
  ProviderConfig,
  ProviderGenerateInput,
  ProviderModelOption
} from "../../shared/types.js";
import { ImageSubmissionError, ProviderError } from "./errors.js";
import { mapWithConcurrency, Semaphore } from "./concurrency.js";
import { setTimeout as delay } from "node:timers/promises";

type FetchLike = typeof fetch;

interface OpenAIImageItem {
  b64_json?: string;
  url?: string;
}

interface OpenAIResponsesOutputItem {
  type?: string;
  result?: string;
}

interface OpenAIResponsePayload {
  data?: OpenAIImageItem[];
  output?: OpenAIResponsesOutputItem[];
  result?: string;
}

interface ImageTaskPayload {
  object?: string;
  id?: string;
  status?: string;
  result?: { data?: OpenAIImageItem[] };
  task_id?: string;
  response?: OpenAIResponsePayload;
  error?: unknown;
}

const IMAGE_TASK_POLL_MS = 5_000;

interface OpenAIModelsPayload {
  data?: unknown;
  models?: unknown;
}

const networkSemaphore = new Semaphore(4);

export class Sub2ApiImageProvider {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10 * 60 * 1000
  ) {}

  async generate(input: ProviderGenerateInput, config: ProviderConfig, apiKey: string): Promise<GenerationResult> {
    if (input.referenceImages.length > 0) {
      if (!config.supportsReferenceImages) {
        throw new ProviderError("REFERENCE_UNSUPPORTED", "当前 Provider 未声明支持参考图。");
      }

      if (usesJsonImagesApi(config)) {
        return this.generateWithJsonImages(input, config, apiKey);
      }

      if (usesResponsesApi(config)) {
        return this.generateWithResponses(input, config, apiKey);
      }

      return this.generateWithReferences(input, config, apiKey);
    }

    if (input.workflowMode === "edit") {
      throw new ProviderError("EDIT_IMAGE_REQUIRED", "编辑模式至少需要上传 1 张源图。");
    }

    if (usesResponsesApi(config)) {
      return this.generateWithResponses(input, config, apiKey);
    }

    const endpoint = joinUrl(config.baseUrl, config.generationEndpoint);
    const body = {
      prompt: input.prompt,
      model: input.model || config.model,
      size: input.size,
      n: input.n,
      quality: input.quality || undefined,
      style: input.style || undefined,
      background: input.background === "auto" ? undefined : input.background,
      output_format: input.outputFormat ?? "png",
      response_format: config.compatResponseFormat || undefined
    };
    if (input.recoverImageSubmission && input.clientRequestId)
      return withRequestedCountWarning(await this.submitRecoverableImage(endpoint, apiKey, body, input.clientRequestId), input.n);
    const response = await this.fetchWithTimeout(endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    return withRequestedCountWarning(await this.parseGenerationResponse(response, endpoint, apiKey), input.n);
  }

  async testConnection(config: ProviderConfig, apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new ProviderError("UNAUTHORIZED", "请先填写 API Key。");
    if (config.type === "openrouter" || config.type === "poe") {
      const endpoint = config.type === "openrouter" ? "/v1/key" : "/usage/current_balance";
      const response = await this.fetchWithTimeout(joinUrl(config.baseUrl, endpoint), {
        headers: { Authorization: `Bearer ${apiKey}` }
      }, 15_000);
      if (!response.ok) await throwProviderError(response);
      return;
    }

    // 只读模型目录，不提交图片或文本生成。目录出现模型不代表实际能力已验证。
    const response = await this.fetchWithTimeout(modelListUrl(config.baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}` }
    }, 15_000);
    if (!response.ok) await throwProviderError(response);
  }

  async listModels(config: ProviderConfig, apiKey: string): Promise<ProviderModelOption[]> {
    if (!config.baseUrl.trim()) throw new ProviderError("INVALID_CONFIG", "请先填写 Base URL。");
    if (!apiKey.trim()) throw new ProviderError("UNAUTHORIZED", "请先填写 API Key。");

    const response = await this.fetchWithTimeout(modelListUrl(config.baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}` }
    }, 15_000);
    if (!response.ok) await throwProviderError(response);

    const payload = (await response.json()) as OpenAIModelsPayload;
    return parseProviderModels(payload);
  }

  private async generateWithReferences(
    input: ProviderGenerateInput,
    config: ProviderConfig,
    apiKey: string
  ): Promise<GenerationResult> {
    const endpoint = config.referenceEndpoint || "/v1/images/edits";
    const form = new FormData();
    form.append("prompt", input.prompt);
    form.append("model", input.model || config.model);
    form.append("size", input.size);
    form.append("n", String(input.n));
    if (config.compatResponseFormat) form.append("response_format", config.compatResponseFormat);
    if (input.quality) form.append("quality", input.quality);
    if (input.style) form.append("style", input.style);
    if (input.background && input.background !== "auto") form.append("background", input.background);
    form.append("output_format", input.outputFormat ?? "png");

    for (const [index, image] of input.referenceImages.entries()) {
      const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
      form.append(input.referenceImages.length === 1 ? "image" : `image[${index}]`, blob, image.name);
    }

    const response = await this.fetchWithTimeout(joinUrl(config.baseUrl, endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });

    return withRequestedCountWarning(await this.parseResponse(response), input.n);
  }

  private async generateWithJsonImages(
    input: ProviderGenerateInput,
    config: ProviderConfig,
    apiKey: string
  ): Promise<GenerationResult> {
    const response = await this.fetchWithTimeout(joinUrl(config.baseUrl, config.generationEndpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: input.prompt,
        model: input.model || config.model,
        size: input.size,
        n: input.n,
        quality: input.quality || undefined,
        background: input.background === "auto" ? undefined : input.background,
        output_format: input.outputFormat ?? "png",
        input_references: input.referenceImages.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` }
        }))
      })
    });
    return withRequestedCountWarning(await this.parseResponse(response), input.n);
  }

  // Responses API 一次请求只产一张图：并行发 n 个请求，容忍部分失败——
  // 只要有成功的图就返回（失败原因转为 warning），全部失败才抛错。
  private async generateWithResponses(
    input: ProviderGenerateInput,
    config: ProviderConfig,
    apiKey: string
  ): Promise<GenerationResult> {
    const count = Math.max(1, input.n);
    const attempts = await mapWithConcurrency(
      Array.from({ length: count }, (_, index) => index),
      2,
      () => this.requestResponsesImage(input, config, apiKey)
    );

    const images: GenerationResult["images"] = [];
    const failures: unknown[] = [];
    for (const attempt of attempts) {
      if (attempt.status === "fulfilled") images.push(...attempt.value.images);
      else failures.push(attempt.reason);
    }

    if (images.length === 0) {
      throw failures[0] ?? new ProviderError("EMPTY_RESPONSE", "Provider 未返回图片。");
    }

    if (failures.length > 0) {
      return {
        images,
        warnings: [`请求 ${count} 张，其中 ${failures.length} 张生成失败：${describeFailure(failures[0])}`]
      };
    }

    return { images };
  }

  private async requestResponsesImage(
    input: ProviderGenerateInput,
    config: ProviderConfig,
    apiKey: string
  ): Promise<GenerationResult> {
    const response = await this.fetchWithTimeout(joinUrl(config.baseUrl, config.generationEndpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildResponsesRequestBody(input, config))
    });
    return this.parseResponse(response);
  }

  private async parseResponse(response: Response): Promise<GenerationResult> {
    return parseOpenAIImageResponse(response, (input, init) => this.fetchWithTimeout(input, init));
  }

  private async submitRecoverableImage(endpoint: string, apiKey: string, body: Record<string, unknown>, requestId: string): Promise<GenerationResult> {
    const url = new URL(endpoint);
    const directImages = /^\/v1\/images\/generations\/?$/.test(url.pathname);
    const aiPai = directImages && url.origin === "https://aipaiai.cn";
    const toApis = directImages && ["https://toapis.cn", "https://toapis.com"].includes(url.origin);
    if (aiPai) url.pathname = "/v1/images/generations/tasks";
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
      ...(aiPai ? { "Idempotency-Key": requestId } : {}) };
    const encoded = JSON.stringify({
      ...body,
      ...(aiPai ? { response_format: body.response_format || "url" } : {}),
      ...(toApis ? { client_business_id: requestId, ...(body.size === "auto" ? { size: "1:1" } : {}) } : {})
    });
    const submit = () => this.fetchWithTimeout(url.href, { method: "POST", headers, body: encoded, redirect: "error" },
      aiPai || toApis ? Math.min(this.timeoutMs, 20_000) : this.timeoutMs);
    const uncertain = () => new ImageSubmissionError("unknown", "IMAGE_SUBMISSION_UNKNOWN",
      `服务端受理状态待确认（本次请求 ${requestId}）。请核对原渠道任务。`);
    let response = await submit().catch(() => undefined);
    if (!response || response.status >= 500 || response.status === 408) {
      await response?.body?.cancel().catch(() => undefined);
      if (aiPai) {
        // This endpoint uses the identical key and payload to rediscover the original task.
        response = await submit().catch(() => undefined);
        // A rejection of a recovery request cannot prove the first submission failed.
        if (!response?.ok) throw uncertain();
      } else if (toApis) {
        return this.waitForImageTask(url.href, apiKey, requestId, {}, true);
      } else {
        throw uncertain();
      }
    }
    if (!response.ok) {
      const status = response.status;
      const info = await response.text().catch(() => "");
      if (isImageContentBlocked(info))
        throw new ImageSubmissionError("blocked", "IMAGE_CONTENT_BLOCKED", "图片请求未通过服务端内容审核。", status);
      if (/submission_unknown/i.test(info) || ![400, 401, 402, 403, 404, 422, 429].includes(status)) throw uncertain();
      throw new ImageSubmissionError("rejected", "IMAGE_SUBMISSION_REJECTED", `服务端拒绝提交（HTTP ${status}）。`, status);
    }
    const payload = await readResponsePayload(response).catch(() => { throw uncertain(); });
    const task = payload as ImageTaskPayload;
    if (toApis && task.object === "generation.task" && task.id) return this.waitForImageTask(url.href, apiKey, task.id, task);
    if (aiPai && task.task_id) return this.waitForImageTask(url.href, apiKey, task.task_id, task);
    if (aiPai || toApis) {
      if (!getImageItems(payload).length) {
        if (toApis) return this.waitForImageTask(url.href, apiKey, requestId, {}, true);
        throw uncertain();
      }
    }
    return decodeOpenAIImageItems(getImageItems(payload), input => this.fetchWithTimeout(input));
  }

  private async parseGenerationResponse(response: Response, endpoint: string, apiKey: string): Promise<GenerationResult> {
    if (!response.ok) await throwProviderError(response);
    const payload = await readResponsePayload(response);
    const task: ImageTaskPayload = payload as ImageTaskPayload;
    const fetchImage = (url: string) => this.fetchWithTimeout(url);
    if (task.object !== "generation.task" || typeof task.id !== "string" || !task.id) {
      return decodeOpenAIImageItems(getImageItems(payload), fetchImage);
    }
    return this.waitForImageTask(endpoint, apiKey, task.id, task);
  }

  private async waitForImageTask(endpoint: string, apiKey: string, id: string, initial: ImageTaskPayload, discover = false): Promise<GenerationResult> {
    const unknown = () => new ImageSubmissionError("unknown", "IMAGE_TASK_UNKNOWN",
      `图片任务状态待确认（任务或业务 ID ${id}）。请核对原渠道任务。`);
    if (!/^[\w-]{1,200}$/.test(id)) throw new ProviderError("INVALID_RESPONSE", "图片服务返回了无效的任务 ID。");
    const taskUrl = new URL(endpoint);
    taskUrl.pathname = taskUrl.pathname.replace(/\/$/, "") + "/" + encodeURIComponent(id);
    const deadline = Date.now() + this.timeoutMs;
    let current = initial;
    let pollDelay = discover ? 0 : IMAGE_TASK_POLL_MS;
    let missing = 0;
    for (;;) {
      if (current.status === "completed") {
        const items = getImageItems(current.response ?? { data: current.result?.data });
        return decodeOpenAIImageItems(items, url => this.fetchWithTimeout(url)).catch(() => { throw unknown(); });
      }
      if (current.status === "failed" || current.status === "cancelled") {
        const blocked = isImageContentBlocked(JSON.stringify(current.error ?? ""));
        throw new ImageSubmissionError(blocked ? "blocked" : "failed", "IMAGE_TASK_FAILED", extractErrorValue(current.error) || `图片任务未完成（任务 ID ${id}）。`);
      }
      if (current.status === "submission_unknown") throw unknown();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw unknown();
      if (pollDelay) await delay(Math.min(pollDelay, remaining));
      const timeLeft = deadline - Date.now();
      if (timeLeft <= 0) throw unknown();
      pollDelay = IMAGE_TASK_POLL_MS;
      const poll = await this.fetchWithTimeout(taskUrl.href, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error" },
        Math.min(timeLeft, 15_000)).catch(() => undefined);
      if (!poll) continue;
      if (!poll.ok) {
        const retryAfter = Number(poll.headers.get("retry-after"));
        await poll.body?.cancel();
        if (poll.status === 429) pollDelay = Math.max(IMAGE_TASK_POLL_MS, retryAfter * 1000 || 0);
        else if (poll.status === 404 && ++missing >= 3) throw unknown();
        else if (poll.status !== 404 && poll.status < 500) throw unknown();
        continue;
      }
      current = await poll.json().catch(() => ({})) as ImageTaskPayload;
      if (current.status) missing = 0;
    }
  }

  private async fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs
  ): Promise<Response> {
    return networkSemaphore.run(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await this.fetchImpl(input, { ...init, signal: controller.signal });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ProviderError("TIMEOUT", "图片生成请求超时，请稍后重试。");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

export async function parseOpenAIImageResponse(
  response: Response,
  fetchImage: (input: string, init?: RequestInit) => Promise<Response> = fetch
): Promise<GenerationResult> {
  if (!response.ok) await throwProviderError(response);
  return decodeOpenAIImageItems(getImageItems(await readResponsePayload(response)), fetchImage);
}

async function decodeOpenAIImageItems(
  imageItems: OpenAIImageItem[],
  fetchImage: (input: string) => Promise<Response>
): Promise<GenerationResult> {
  if (imageItems.length === 0) {
    throw new ProviderError("EMPTY_RESPONSE", "Provider 未返回图片。");
  }

  const images = await Promise.all(
    imageItems.map(async (item): Promise<{ bytes: Buffer; mimeType: string }> => {
      if (item.b64_json) {
        return {
          bytes: Buffer.from(item.b64_json, "base64"),
          mimeType: "image/png"
        };
      }

      if (item.url) {
        if (item.url.startsWith("data:")) return decodeDataUrl(item.url);
        const imageResponse = await fetchImage(item.url);
        if (!imageResponse.ok) await throwProviderError(imageResponse);
        return {
          bytes: Buffer.from(await imageResponse.arrayBuffer()),
          mimeType: imageResponse.headers.get("content-type") || "image/png"
        };
      }

      throw new ProviderError("INVALID_RESPONSE", "Provider 返回了无法识别的图片格式。");
    })
  );
  return { images };
}

// 一些中转站会忽略/不支持 n>1，只回 1 张——补一条警告让 UI 能解释占位符为什么消失。
function withRequestedCountWarning(result: GenerationResult, requested: number): GenerationResult {
  const count = Math.max(1, requested);
  if (result.images.length >= count) return result;
  return {
    ...result,
    warnings: [
      ...(result.warnings || []),
      `请求 ${count} 张，Provider 实际返回 ${result.images.length} 张（该端点可能不支持一次生成多张）。`
    ]
  };
}

function describeFailure(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason ?? "未知错误");
}

function usesResponsesApi(config: ProviderConfig): boolean {
  return config.apiMode === "responses" || /\/responses\/?$/.test(config.generationEndpoint);
}

function usesJsonImagesApi(config: ProviderConfig): boolean {
  return config.type === "openrouter";
}

function buildResponsesRequestBody(input: ProviderGenerateInput, config: ProviderConfig): Record<string, unknown> {
  const tool: Record<string, string> = { type: "image_generation" };
  if (input.size) tool.size = input.size;
  if (input.quality) tool.quality = input.quality;
  if (input.background && input.background !== "auto") tool.background = input.background;
  tool.output_format = input.outputFormat ?? "png";

  return {
    model: input.model || config.model,
    input: buildResponsesInput(input),
    tools: [tool]
  };
}

function buildResponsesInput(input: ProviderGenerateInput): string | Array<Record<string, unknown>> {
  if (input.referenceImages.length === 0) {
    // 纯文本生成才补比例提示：许多"OpenAI 兼容"中转会忽略 image_generation 的 size，
    // 这类模型往往能从提示词里读到目标比例/朝向。编辑与参考图不加，避免与源图/参考图冲突。
    const hint = buildResponsesSizeHint(input);
    return hint ? `${input.prompt}\n\n${hint}` : input.prompt;
  }

  return [
    {
      role: "user",
      content: [
        { type: "input_text", text: input.prompt },
        ...input.referenceImages.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`
        }))
      ]
    }
  ];
}

/** 目标比例/朝向/尺寸提示：作为 size 参数被上游忽略时的兜底（仅生成模式）。 */
function buildResponsesSizeHint(input: ProviderGenerateInput): string | null {
  if (input.workflowMode !== "generate") return null;
  const match = /^(\d+)x(\d+)$/i.exec((input.size || "").trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  const divisor = gcd(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  const orientation = width === height ? "square" : width > height ? "landscape" : "portrait";
  return `Target aspect ratio ${ratio} (${orientation}), output resolution ${width}x${height}. Compose and render the entire image at exactly this aspect ratio.`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function getImageItems(payload: OpenAIResponsePayload): OpenAIImageItem[] {
  const imageItems = payload.data || [];
  const responseImageItems =
    payload.output
      ?.filter((item) => item.type === "image_generation_call" && item.result)
      .map((item) => ({ b64_json: item.result })) || [];
  const resultImageItems = payload.result ? [{ b64_json: payload.result }] : [];

  return [...imageItems, ...responseImageItems, ...resultImageItems];
}

async function readResponsePayload(response: Response): Promise<OpenAIResponsePayload> {
  const contentType = response.headers?.get("content-type")?.toLowerCase() || "";
  if (contentType.includes("text/event-stream")) {
    return parseEventStreamPayload(await response.text());
  }

  // 部分兼容端点漏写 SSE Content-Type。原生 Response 可提前 clone，JSON 解析失败后再回退读取流文本。
  const fallback = typeof response.clone === "function" ? response.clone() : null;
  try {
    return (await response.json()) as OpenAIResponsePayload;
  } catch (error) {
    if (!fallback) throw error;
    const text = await fallback.text();
    if (/^\s*(?:event|data):/m.test(text)) return parseEventStreamPayload(text);
    throw error;
  }
}

function parseEventStreamPayload(stream: string): OpenAIResponsePayload {
  let imagePayload: OpenAIResponsePayload | null = null;
  let eventError = "";
  let dataLines: string[] = [];

  const consumeEvent = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;

    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    for (const candidate of getEventPayloadCandidates(event)) {
      if (getImageItems(candidate).length > 0) imagePayload = candidate;
    }
    eventError = extractEventError(event) || eventError;
  };

  for (const line of stream.split(/\r?\n/)) {
    if (line === "") {
      consumeEvent();
      continue;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  consumeEvent();

  if (imagePayload) return imagePayload;
  if (eventError) throw new ProviderError("PROVIDER_ERROR", eventError);
  throw new ProviderError("EMPTY_RESPONSE", "Provider 的流式响应未返回图片。");
}

function getEventPayloadCandidates(event: unknown): OpenAIResponsePayload[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  const candidates: OpenAIResponsePayload[] = [record as OpenAIResponsePayload];
  if (record.response && typeof record.response === "object") {
    candidates.push(record.response as OpenAIResponsePayload);
  }
  for (const key of ["item", "output_item"] as const) {
    const item = record[key];
    if (item && typeof item === "object") {
      candidates.push({ output: [item as OpenAIResponsesOutputItem] });
    }
  }
  return candidates;
}

function extractEventError(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  const direct = extractErrorValue(record.error);
  if (direct) return direct;
  if (record.response && typeof record.response === "object") {
    return extractErrorValue((record.response as Record<string, unknown>).error);
  }
  return "";
}

function extractErrorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : "";
}

function joinUrl(baseUrl: string, endpoint: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  if (trimmedBase.endsWith("/v1") && normalizedEndpoint.startsWith("/v1/"))
    return trimmedBase + normalizedEndpoint.slice(3);
  return `${trimmedBase}${normalizedEndpoint}`;
}

function modelListUrl(baseUrl: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmedBase);
    return joinUrl(trimmedBase, /\/v1$/.test(url.pathname) ? "/models" : "/v1/models");
  } catch {
    return joinUrl(trimmedBase, "/v1/models");
  }
}

function parseProviderModels(payload: OpenAIModelsPayload): ProviderModelOption[] {
  const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const seen = new Set<string>();
  const models: ProviderModelOption[] = [];

  for (const item of raw) {
    const id = typeof item === "string"
      ? item.trim()
      : item && typeof item === "object"
        ? String((item as { id?: unknown; model?: unknown }).id ?? (item as { model?: unknown }).model ?? "").trim()
        : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = item && typeof item === "object" && typeof (item as { owned_by?: unknown }).owned_by === "string"
      ? (item as { owned_by: string }).owned_by.trim() || undefined
      : undefined;
    models.push({ id, ownedBy });
  }

  return models.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function decodeDataUrl(value: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) throw new ProviderError("INVALID_RESPONSE", "Provider 返回了无效的图片 Data URL。");
  return {
    bytes: Buffer.from(decodeURIComponent(match[3]), match[2] ? "base64" : "utf8"),
    mimeType: match[1] || "image/png"
  };
}

async function throwProviderError(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  const message = extractErrorMessage(text) || response.statusText || "Provider request failed";
  if (isImageContentBlocked(text))
    throw new ImageSubmissionError("blocked", "IMAGE_CONTENT_BLOCKED", message, response.status);
  if (message.includes("Images API is not supported for this platform")) {
    throw new ProviderError(
      "IMAGES_API_UNSUPPORTED",
      "当前 Provider 暂不支持 Images API，请切到 Responses 模式或更换支持 /v1/images 的端点。",
      response.status
    );
  }
  if (isUnsupportedImageGenerationToolError(message)) {
    throw new ProviderError(
      "UNSUPPORTED_IMAGE_GENERATION_TOOL",
      "当前 Provider 的 Responses API 不支持 OpenAI image_generation 图像工具。请换用支持该工具的 OpenAI 兼容端点，或切到 Images API 并使用 gpt-image-1/gpt-image-1.5。",
      response.status
    );
  }
  if (response.status === 401 || response.status === 403) {
    if (/pre_consume_token_quota_failed|insufficient_quota/.test(text)) {
      throw new ProviderError("INSUFFICIENT_QUOTA", "当前 API Key 的可用额度不足，请检查令牌额度。", response.status);
    }
    throw new ProviderError("UNAUTHORIZED", "Provider 鉴权失败，请检查 API Key。", response.status);
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    throw new ProviderError("PROVIDER_UNAVAILABLE", message, response.status);
  }
  throw new ProviderError("PROVIDER_ERROR", message, response.status);
}

function isImageContentBlocked(value: string): boolean {
  return /content_policy|safety|moderation|违规|内容安全|未通过审核/i.test(value);
}

function extractErrorMessage(text: string): string {
  if (!text) return "";

  try {
    const payload = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    if (typeof payload.error?.message === "string") return payload.error.message;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    return text;
  }

  return text;
}

function isUnsupportedImageGenerationToolError(message: string): boolean {
  return (
    message.includes("image_generation") &&
    (message.includes("does not match any of the expected tags") || message.includes("expected tags"))
  );
}
