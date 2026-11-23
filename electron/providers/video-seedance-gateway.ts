import type { SeedanceGatewayType } from "../../shared/contracts/providers.js";
import { seedanceGatewayModelOption } from "../../shared/video-provider-models.js";
import { ProviderError } from "./errors.js";
import type { SeedanceGatewayVideoConfig, VideoProvider, VideoProviderCapability, VideoProviderConfig,
  VideoRemoteOutput, VideoRemoteStatus, VideoRemoteTask, VideoRequestOptions, VideoSubmitInput } from "./video-types.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string { return typeof value === "string" ? value : ""; }

function urlFor(value: string | undefined): URL | undefined {
  try {
    const url = new URL(value ?? "");
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* Invalid URL. */ }
}

function aiPaiBody(input: VideoSubmitInput) {
  const media = input.inputs ?? [];
  const first = media.find(item => item.role === "first-frame");
  const last = media.find(item => item.role === "last-frame");
  const reference = media.length && !first;
  return {
    prompt: input.prompt,
    mode: reference ? "reference_material" : last ? "i2v_first_last" : first ? "i2v" : "t2v",
    ...(reference ? { function_mode: "omni_reference" } : {}),
    ...(media.length ? { content: [
      { type: "text", text: input.prompt },
      ...media.map((item, index) => ({
        type: `${item.kind}_url`,
        [`${item.kind}_url`]: { url: item.url },
        role: item.role.replaceAll("-", "_"),
        name: `${item.kind}_${index + 1}`
      }))
    ] } : {}),
    ...(input.ratio ? { ratio: input.ratio } : {})
  };
}

function toApisBody(input: VideoSubmitInput) {
  const media = input.inputs ?? [];
  return {
    prompt: input.prompt, ...(input.ratio ? { aspect_ratio: input.ratio } : {}),
    ...(input.clientRequestId ? { client_business_id: input.clientRequestId } : {}),
    ...Object.fromEntries(["image", "video", "audio"].flatMap(kind => {
      const items = media.filter(item => item.kind === kind).map(item => ({ url: item.url, role: item.role.replaceAll("-", "_") }));
      return items.length ? [[`${kind}_with_roles`, items]] : [];
    }))
  };
}

function taskStatus(value: string): VideoRemoteStatus {
  switch (value) {
    case "completed": case "succeeded": return "succeeded";
    case "failed": return "failed";
    case "cancelled": case "canceled": return "cancelled";
    case "expired": return "expired";
    case "queued": return "queued";
    default: return "running";
  }
}

export class SeedanceGatewayVideoProvider implements VideoProvider {
  readonly capability: VideoProviderCapability;

  constructor(private readonly type: SeedanceGatewayType, private readonly fetcher: typeof fetch = fetch) {
    this.capability = { ...seedanceGatewayModelOption(type, "").capability!, provider: type };
  }

  async listModels(config: VideoProviderConfig) {
    return [seedanceGatewayModelOption(this.type, config.model)];
  }

  async submit(input: VideoSubmitInput, config: VideoProviderConfig, options: VideoRequestOptions = {}): Promise<VideoRemoteTask> {
    const connection = this.connection(config);
    const media = input.inputs ?? [];
    if (input.mode && input.mode !== "generate") throw new ProviderError("INVALID_REQUEST", "此 Seedance 渠道支持视频生成。");
    if (media.some(item => item.role === "last-frame") && !media.some(item => item.role === "first-frame"))
      throw new ProviderError("INVALID_REQUEST", "设置尾帧时请同时提供首帧。");
    if (media.some(item => item.role === "first-frame") && media.some(item => item.role.startsWith("reference-")))
      throw new ProviderError("INVALID_REQUEST", "首尾帧与多素材参考需要分开提交。");
    const model = input.model?.trim() || connection.model;
    const toApis = this.type === "seedance-toapis";
    const option = seedanceGatewayModelOption(this.type, model);
    if (!input.prompt.trim() && (option.requiresPrompt || !media.some(item => item.kind === "audio")))
      throw new ProviderError("INVALID_REQUEST", "请填写视频描述。");
    if (!toApis && option.capability?.durationSeconds.max === 15 && media.length > 12)
      throw new ProviderError("INVALID_REQUEST", "Seedance 2.0 最多接收 12 个参考素材。");
    if (media.some(item => !urlFor(item.url) && (!toApis || !item.bytes?.length)))
      throw new ProviderError("INVALID_REQUEST", "此 Seedance 渠道需要公网素材链接。本地素材可使用 ToAPIs 渠道。");
    const prepared = { ...input, inputs: [] as typeof media };
    if (toApis && option.capability?.durationSeconds.max === 30 && media.some(item => item.role === "first-frame")) {
      prepared.ratio = "adaptive";
    }
    for (const item of media) {
      const url = urlFor(item.url) ?? await this.upload(item, connection, options.signal);
      prepared.inputs.push({ ...item, url: url.href });
    }
    const body = {
      model, ...(toApis ? toApisBody(prepared) : aiPaiBody(prepared)),
      ...(input.durationSeconds === undefined ? {} : { duration: input.durationSeconds === "auto" ? -1 : input.durationSeconds }),
      ...(input.resolution ? { resolution: input.resolution } : {}),
      ...(toApis && input.generateAudio !== undefined ? { generate_audio: input.generateAudio } : {})
    };
    const now = new Date().toISOString();
    try {
      const response = await this.request(this.endpoint(connection), connection, options.signal, body);
      const { data, ...payload } = object(await response.json().catch(() => undefined));
      const task = { ...object(data), ...payload };
      const id = str(task.id) || str(task.task_id) || str(data);
      if (!id) throw new ProviderError("INVALID_RESPONSE", "Seedance 未返回视频任务 ID。");
      const status = taskStatus(str(task.status) || "queued");
      return { provider: this.type, id, model, status: status === "succeeded" ? "running" : status, submittedAt: now, updatedAt: now };
    } catch (error) {
      if (toApis && input.clientRequestId && error instanceof ProviderError &&
        (["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE"].includes(error.code) || (error.status ?? 0) >= 500)) {
        const recovered = await this.poll({
          provider: this.type, id: input.clientRequestId, model, status: "queued", submittedAt: now, updatedAt: now
        }, config, options).catch(() => undefined);
        if (recovered && recovered.id !== input.clientRequestId) return recovered;
      }
      throw error;
    }
  }

  async poll(task: VideoRemoteTask, config: VideoProviderConfig, options: VideoRequestOptions = {}): Promise<VideoRemoteTask> {
    const connection = this.connection(config);
    const endpoint = `${this.endpoint(connection)}/${encodeURIComponent(task.id)}`;
    const response = await this.request(endpoint, connection, options.signal);
    const { data, ...payload } = object(await response.json());
    const remote = { ...object(data), ...payload };
    const rawStatus = str(remote.status) || task.rawStatus || "in_progress";
    const status = taskStatus(rawStatus);
    const outputs: VideoRemoteOutput[] = [];
    if (status === "succeeded" && this.type === "seedance-aipai") outputs.push({ kind: "video", role: "result", url: `${endpoint}/content` });
    if (status === "succeeded" && this.type === "seedance-toapis") {
      const result = object(remote.result).data;
      for (const item of Array.isArray(result) ? result : []) {
        const { url, last_frame_url } = object(item);
        if (urlFor(str(url))) outputs.push({ kind: "video", role: "result", url: str(url) });
        if (urlFor(str(last_frame_url))) outputs.push({ kind: "image", role: "last-frame", url: str(last_frame_url) });
      }
    }
    const error = str(object(remote.error).message);
    return { ...task, id: str(remote.id) || str(remote.task_id) || task.id, status, rawStatus, updatedAt: new Date().toISOString(), ...(outputs.length ? { outputs } : {}),
      ...(typeof remote.progress === "number" ? { progress: remote.progress } : {}), ...(error ? { error } : {}) };
  }

  async download(output: VideoRemoteOutput, config: VideoProviderConfig, options: VideoRequestOptions = {}) {
    const connection = this.connection(config);
    const url = urlFor(output.url);
    if (!url) throw new ProviderError("DOWNLOAD_FAILED", "Seedance 视频结果链接无效。");
    const response = await this.request(url.href, connection, options.signal, undefined,
      this.type === "seedance-aipai" && url.origin === new URL(this.endpoint(connection)).origin);
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!mimeType.startsWith("video/") || !bytes.length) throw new ProviderError("DOWNLOAD_FAILED", "Seedance 返回了无效的视频文件。");
    return { bytes, mimeType, sourceUrl: url.href };
  }

  async cancel(task: VideoRemoteTask) {
    return { supported: false, cancelled: false, task, message: "该 Seedance 渠道支持停止本地等待。" };
  }

  private connection(config: VideoProviderConfig): SeedanceGatewayVideoConfig {
    if (config.provider === "official" || config.provider !== this.type || !config.apiKey.trim() || !urlFor(config.baseUrl))
      throw new ProviderError("INVALID_CONFIG", "请配置此 Seedance 渠道的地址和 API Key。");
    return config;
  }

  private endpoint(config: SeedanceGatewayVideoConfig): string {
    return `${this.apiRoot(config)}/videos${this.type === "seedance-toapis" ? "/generations" : ""}`;
  }

  private apiRoot(config: SeedanceGatewayVideoConfig): string {
    return config.baseUrl!.replace(/\/+$/u, "").replace(/\/v1$/u, "") + "/v1";
  }

  private async upload(item: NonNullable<VideoSubmitInput["inputs"]>[number], config: SeedanceGatewayVideoConfig, signal?: AbortSignal) {
    const file = new FormData();
    file.append("file", new Blob([Uint8Array.from(item.bytes!)], { type: item.mimeType }), item.name || item.id);
    const response = await this.request(`${this.apiRoot(config)}/uploads/${item.kind}s`, config, signal, file);
    const url = urlFor(str(object(object(await response.json()).data).url));
    if (!url) throw new ProviderError("INVALID_RESPONSE", "ToAPIs 未返回有效素材链接。");
    return url;
  }

  private async request(url: string, config: SeedanceGatewayVideoConfig, signal?: AbortSignal, body?: object, authenticated = true) {
    const timeout = AbortSignal.timeout(config.requestTimeoutMs ?? 120_000);
    let response: Response;
    try {
      response = await this.fetcher(url, { method: body ? "POST" : "GET", redirect: body ? "error" : "follow",
        headers: { ...(authenticated ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch {
      throw new ProviderError(signal?.aborted ? "POLLING_STOPPED" : timeout.aborted ? "TIMEOUT" : "NETWORK_ERROR", "Seedance 视频服务连接中断。");
    }
    if (!response.ok) {
      const status = response.status;
      if (this.type === "seedance-aipai" && body && url === this.endpoint(config)) {
        const payload = object(await response.json().catch(() => undefined));
        if (str(object(payload.error).message).trim().toLowerCase() === "no available channel") {
          throw new ProviderError("CHANNEL_UNAVAILABLE", "当前 Seedance 渠道没有可用资源。", status);
        }
      }
      const code = status === 429 ? "RATE_LIMITED" : status >= 500 ? "PROVIDER_UNAVAILABLE" : `HTTP_${status}`;
      throw new ProviderError(code, `Seedance 视频服务返回 HTTP ${status}。`, status);
    }
    return response;
  }
}
