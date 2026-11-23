import { isSeedanceGateway } from "../../shared/contracts/providers.js";
import { dialog, ipcMain, net, shell } from "electron";

import path from "node:path";

import { getProviderModels } from "../../shared/provider-models.js";

import { isBoardVideoGenerationNode, isBoardVideoNode, VideoGenerationInput, VideoGenerationJob } from "../../shared/types.js";
import { findVideoModelRoute, resolveVideoModelCapability, validateVideoParameters, videoRouteChannels } from "../../shared/video-provider-models.js";

import { PaidMediaQuoteService } from "../paid-media-quote.js";

import { isRetryableTextChannelRejection, normalizeProviderError, ProviderError } from "../providers/errors.js";

import { normalizeFalVideoPrompt } from "../providers/video-fal.js";
import { generateSpeech } from "../providers/audio-speech.js";

import type { VideoProviderConfig as RuntimeVideoProviderConfig, VideoRemoteStatus, VideoRemoteTask } from "../providers/video-types.js";

import {
  ASSET_PROTOCOL,
  AssetStore,
  audioMimeFromExtension,
  extensionFromMime,
  MAX_MANAGED_IMAGE_BYTES,
  mimeFromExtension,
  videoMimeFromExtension
} from "../storage/asset-store.js";

import { BoardStore } from "../storage/board-store.js";

import { SettingsStore } from "../storage/settings-store.js";

import { VideoTaskStore } from "../storage/video-task-store.js";
import { showVideoGenerationNotification } from "../system-notification.js";

import { VideoGenerationService, VideoTaskServiceError } from "../video-generation-service.js";

interface VideoIpcDependencies {
  settings: Pick<SettingsStore, "getSettings" | "getApiKey" | "resolveVideoProviderConnection">;
  assets: Pick<AssetStore, "exportAsset" | "readManagedBytes" | "resolveAssetUrl" | "saveAudioUploadBytes" | "saveVideoOutput" | "saveVideoUploadBytes" | "saveImportedImage" | "toAssetUrl">;
  boards: Pick<BoardStore, "getBoard" | "startVideoGenerationNode" | "finishVideoGenerationNode" | "finishVideoGenerationNodeVersion">;
  videoTasks: Pick<VideoTaskStore, "addJob" | "updateJob" | "listJobs" | "listRecoverableJobs" | "getJob" | "clearJobsByBoard">;
  videoService: VideoGenerationService;
  paidMediaQuotes?: PaidMediaQuoteService;
  onAssetsChanged?: () => void;
}

interface VideoIpcRegistration {
  recover: () => Promise<VideoGenerationJob[]>;
  dispose: () => void;
  stopBoard: (boardId: string) => Promise<void>;
}

export function registerVideoIpc({
  settings,
  assets,
  boards,
  videoTasks,
  videoService,
  onAssetsChanged
}: VideoIpcDependencies): VideoIpcRegistration {
  const activeRuns = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const activeSubmissions = new Set<string>();

  function localMediaPath(reference: string): string {
    if (!reference.startsWith(`${ASSET_PROTOCOL}:`)) return reference;
    const filePath = assets.resolveAssetUrl(reference);
    if (!filePath) throw new ProviderError("INVALID_REQUEST", "视频参考素材链接已失效，请从当前画板重新选择素材。");
    return filePath;
  }

  function providerConfig(input: VideoGenerationInput): { config: RuntimeVideoProviderConfig; providerId: string; providerName: string } {
    const current = settings.getSettings();
    const providerId = input.providerId || current.activeVideoProviderId;
    const provider = current.videoProviders.find((candidate) => candidate.id === providerId);
    if (!provider) throw new ProviderError("INVALID_CONFIG", "视频 Provider 不存在或已被删除。");
    if (provider.type === "official") throw new ProviderError("INVALID_CONFIG", "官方 Provider 已移除，请配置自有服务商。");
    const model = input.model.trim() || provider.model.trim();
    if (!model) throw new ProviderError("INVALID_CONFIG", "请填写视频模型 ID。");
    if (!getProviderModels(provider).includes(model)) {
      throw new ProviderError("INVALID_CONFIG", "所选视频模型不属于当前 Provider，请重新选择模型。");
    }
    const connection = settings.resolveVideoProviderConnection(provider);
    return {
      providerId,
      providerName: provider.name,
      config: {
        provider: provider.type,
        apiKey: connection.apiKey,
        model,
        ...(connection.baseUrl.trim() ? { baseUrl: connection.baseUrl.trim() } : {})
      }
    };
  }

  function remoteTaskFromJob(job: VideoGenerationJob): VideoRemoteTask {
    if (!job.remoteTaskId) throw new ProviderError("INVALID_REQUEST", "该视频任务没有可恢复的远端任务 ID。");
    const status: VideoRemoteStatus = job.status === "queued"
      ? "queued"
      : job.status === "completed"
        ? "succeeded"
        : job.status === "cancelled"
          ? "cancelled"
          : job.status === "failed"
            ? "failed"
            : "running";
    const configuredType = settings.getSettings().videoProviders.find((candidate) => candidate.id === job.providerId)?.type;
    const provider = configuredType === "ark" || configuredType === "fal" || configuredType === "openrouter" || configuredType === "minimax" || isSeedanceGateway(configuredType) ? configuredType : "ark";
    return {
      provider,
      id: job.remoteTaskId,
      model: job.model,
      status,
      submittedAt: job.createdAt,
      updatedAt: job.completedAt || job.createdAt,
      statusUrl: job.remoteStatusUrl,
      responseUrl: job.remoteResponseUrl,
      cancelUrl: job.remoteCancelUrl
    };
  }

  function jobStatus(status: VideoRemoteStatus): VideoGenerationJob["status"] {
    if (status === "queued") return "queued";
    if (status === "succeeded") return "post_processing";
    if (status === "cancelled") return "cancelled";
    if (status === "failed" || status === "expired") return "failed";
    return "generating";
  }

  function targetsVideoVersion(input: VideoGenerationInput): input is VideoGenerationInput & { targetVideoNodeId: string } {
    return input.mode === "remix" && Boolean(input.targetVideoNodeId);
  }

  async function savePoster(
    jobId: string,
    output: NonNullable<VideoRemoteTask["outputs"]>[number] | undefined,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (!output || output.kind !== "image") return undefined;
    try {
      const response = await net.fetch(output.url, { signal });
      if (!response.ok) return undefined;
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || output.mimeType || "image/jpeg";
      if (!mimeType.startsWith("image/")) return undefined;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_MANAGED_IMAGE_BYTES) return undefined;
      return assets.saveImportedImage(jobId, `poster${extensionFromMime(mimeType)}`, bytes);
    } catch {
      return undefined;
    }
  }

  async function finishFailedJob(job: VideoGenerationJob, error: string, cancelled = false): Promise<VideoGenerationJob> {
    const failed: VideoGenerationJob = {
      ...job,
      status: cancelled ? "cancelled" : "failed",
      completedAt: new Date().toISOString(),
      error
    };
    if (job.input.boardId && job.input.generationNodeId) {
      if (targetsVideoVersion(job.input)) {
        await boards.finishVideoGenerationNodeVersion(
          job.input.boardId,
          job.input.generationNodeId,
          job.input.targetVideoNodeId,
          { error }
        );
      } else {
        await boards.finishVideoGenerationNode(job.input.boardId, job.input.generationNodeId, { jobId: job.id, error });
      }
    }
    await videoTasks.updateJob(failed);
    if (!cancelled) showVideoGenerationNotification({ succeeded: false, error });
    return failed;
  }

  async function runJob(
    initialJob: VideoGenerationJob,
    initialTask: VideoRemoteTask,
    config: RuntimeVideoProviderConfig,
    controller: AbortController
  ): Promise<boolean> {
    let currentJob = initialJob;
    let updateChain = Promise.resolve();
    try {
      const task = await videoService.waitForCompletion(initialTask, config, {
        signal: controller.signal,
        onUpdate: (snapshot) => {
          currentJob = {
            ...currentJob,
            status: jobStatus(snapshot.status),
            error: snapshot.error,
            remoteTaskId: snapshot.id,
            remoteStatusUrl: snapshot.statusUrl,
            remoteResponseUrl: snapshot.responseUrl,
            remoteCancelUrl: snapshot.cancelUrl
          };
          const updatedJob = currentJob;
          updateChain = updateChain.then(() => videoTasks.updateJob(updatedJob));
        }
      });
      await updateChain;
      if (task.status !== "succeeded") {
        await finishFailedJob(currentJob, task.error || (task.status === "expired" ? "视频任务已过期。" : "视频生成失败。"), task.status === "cancelled");
        return false;
      }
      const output = task.outputs?.find((candidate) => candidate.kind === "video");
      if (!output) throw new ProviderError("INVALID_RESPONSE", "火山方舟任务完成但没有返回视频地址。");
      currentJob = { ...currentJob, status: "post_processing", error: undefined };
      await videoTasks.updateJob(currentJob);
      const downloaded = await videoService.download(task, output, config, controller.signal);
      const videoPath = await assets.saveVideoOutput(currentJob.id, downloaded.bytes, downloaded.mimeType);
      const posterPath = await savePoster(
        currentJob.id,
        task.outputs?.find((candidate) => candidate.role === "last-frame"),
        controller.signal
      );
      const completed: VideoGenerationJob = {
        ...currentJob,
        status: "completed",
        completedAt: new Date().toISOString(),
        outputVideoPath: videoPath,
        ...(posterPath ? { outputPosterPath: posterPath } : {}),
        mimeType: downloaded.mimeType,
        error: undefined
      };
      if (completed.input.boardId && completed.input.generationNodeId) {
        const version = {
          videoPath,
          ...(posterPath ? { posterPath } : {}),
          jobId: completed.id,
          mimeType: downloaded.mimeType,
          ...(completed.width ? { width: completed.width } : {}),
          ...(completed.height ? { height: completed.height } : {}),
          aspectRatio: completed.input.aspectRatio,
          ...(completed.durationMs ? { durationMs: completed.durationMs } : {})
        };
        if (targetsVideoVersion(completed.input)) {
          await boards.finishVideoGenerationNodeVersion(
            completed.input.boardId,
            completed.input.generationNodeId,
            completed.input.targetVideoNodeId,
            { jobId: completed.id, version }
          );
        } else {
          await boards.finishVideoGenerationNode(completed.input.boardId, completed.input.generationNodeId, {
            jobId: completed.id,
            node: {
              id: crypto.randomUUID(),
              type: "video",
              ...version,
              source: "generated"
            }
          });
        }
        onAssetsChanged?.();
      }
      await videoTasks.updateJob(completed);
      showVideoGenerationNotification({ succeeded: true });
    } catch (error) {
      await updateChain;
      if (error instanceof VideoTaskServiceError && error.recoverable) {
        const stopped = error.code === "POLLING_STOPPED";
        await videoTasks.updateJob({
          ...currentJob,
          status: stopped ? jobStatus(error.task.status) : "recovering",
          error: stopped ? undefined : error.message
        });
        return !stopped && !controller.signal.aborted;
      } else {
        const normalized = normalizeProviderError(error);
        await finishFailedJob(currentJob, normalized.message);
      }
    }
    return false;
  }

  function startBackgroundRun(job: VideoGenerationJob, task: VideoRemoteTask, config: RuntimeVideoProviderConfig): void {
    if (activeRuns.has(job.id)) return;
    const controller = new AbortController();
    const promise = (async () => {
      let currentJob = job;
      let currentTask = task;
      while (!controller.signal.aborted) {
        const retry = await runJob(currentJob, currentTask, config, controller);
        if (!retry || controller.signal.aborted) break;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 10_000);
          controller.signal.addEventListener("abort", done, { once: true });
        });
        if (controller.signal.aborted) break;
        const latest = await videoTasks.getJob(job.id);
        if (!latest?.remoteTaskId || ["completed", "failed", "cancelled"].includes(latest.status)) break;
        currentJob = latest;
        currentTask = remoteTaskFromJob(latest);
      }
    })().catch((error) => console.error("视频任务后台处理失败。", error))
      .finally(() => { if (activeRuns.get(job.id)?.controller === controller) activeRuns.delete(job.id); });
    activeRuns.set(job.id, { controller, promise });
  }

  ipcMain.handle("video:import", async (_event, data: ArrayBuffer, mimeType: string) => {
    if (!(data instanceof ArrayBuffer)) throw new ProviderError("INVALID_REQUEST", "视频文件数据无效。");
    const videoPath = await assets.saveVideoUploadBytes(Buffer.from(data), mimeType);
    return { path: videoPath, mimeType, videoUrl: assets.toAssetUrl(videoPath) };
  });
  ipcMain.handle("audio:import", async (_event, data: ArrayBuffer, mimeType: string) => {
    if (!(data instanceof ArrayBuffer)) throw new ProviderError("INVALID_REQUEST", "音频文件数据无效。");
    const audioPath = await assets.saveAudioUploadBytes(Buffer.from(data), mimeType);
    return { path: audioPath, mimeType, audioUrl: assets.toAssetUrl(audioPath) };
  });
  ipcMain.handle("audio:synthesize", async (_event, input: { text: string; model?: string }) => {
    const current = settings.getSettings();
    const output = await generateSpeech(input, current.otherModelRouting?.audio, current.audioProviders ?? [],
      id => settings.getApiKey(id));
    const file = await assets.saveAudioUploadBytes(output.bytes, output.mimeType);
    return { path: file, mimeType: output.mimeType, audioUrl: assets.toAssetUrl(file) };
  });

  ipcMain.handle("video:capabilities", () => videoService.capability("ark"));
  ipcMain.handle("video:list", async (_event, boardId?: string) => {
    const jobs = await videoTasks.listJobs();
    return boardId ? jobs.filter((job) => job.input.boardId === boardId) : jobs;
  });
  ipcMain.handle("video:clear", (_event, boardId: string) => videoTasks.clearJobsByBoard(boardId));
  ipcMain.handle("video:get", (_event, jobId: string) => videoTasks.getJob(jobId));
  const pendingVideoStarts = new Map<string, Promise<VideoGenerationJob>>();
  const startVideo = async (_event: unknown, submission: VideoGenerationInput): Promise<VideoGenerationJob> => {
    const hasMediaInput = Boolean(
      submission?.firstFramePath
      || submission?.lastFramePath
      || submission?.sourceVideoPath
      || submission?.referenceImagePaths?.length
      || submission?.referenceVideoPaths?.length
      || submission?.referenceAudioPaths?.length
    );
    if (!submission || typeof submission !== "object" || !Array.isArray(submission.referenceImagePaths) || (!submission.prompt?.trim() && !hasMediaInput)) {
      throw new ProviderError("INVALID_REQUEST", "请输入视频描述或添加媒体参考。");
    }
    if (submission.idempotencyKey) {
      const existing = (await videoTasks.listJobs()).find((job) => job.input.idempotencyKey === submission.idempotencyKey);
      if (existing) return existing;
    }
    const input = {
      ...submission,
      firstFramePath: submission.firstFramePath && localMediaPath(submission.firstFramePath),
      lastFramePath: submission.lastFramePath && localMediaPath(submission.lastFramePath),
      sourceVideoPath: submission.sourceVideoPath && localMediaPath(submission.sourceVideoPath),
      referenceImagePaths: [...new Set(submission.referenceImagePaths.map(localMediaPath))],
      referenceVideoPaths: submission.referenceVideoPaths && [...new Set(submission.referenceVideoPaths.map(localMediaPath))],
      referenceAudioPaths: submission.referenceAudioPaths && [...new Set(submission.referenceAudioPaths.map(localMediaPath))]
    };
    const hasImageInput = Boolean(input.firstFramePath || input.lastFramePath || input.referenceImagePaths.length);
    const current = settings.getSettings();
    const route = input.useVideoRouting ? findVideoModelRoute(current.otherModelRouting?.video, input.model) : undefined;
    if (input.useVideoRouting && !route) throw new ProviderError("INVALID_CONFIG", "所选视频模型未在模型设置中配置。");
    const validateChannel = (resolved: ReturnType<typeof providerConfig>, option: Awaited<ReturnType<VideoGenerationService["modelOption"]>>) => {
      if (input.requireFirstLastFrameCapability) {
        if (!input.firstFramePath || !input.lastFramePath) {
          throw new ProviderError("INVALID_REQUEST", "漫剧视频必须连接已采用的首帧和尾帧。");
        }
        const capability = resolveVideoModelCapability(option, "first-last-frame");
        if (capability !== "supported") {
          throw new ProviderError("UNSUPPORTED_MODEL_CAPABILITY", capability === "unknown"
            ? "当前模型的首尾帧能力未知，请切换模型或检查 Provider 配置。"
            : "当前模型不支持首尾帧生成，请切换模型。");
        }
      }
      const prompt = resolved.config.provider === "fal"
        ? normalizeFalVideoPrompt(input.prompt, resolved.config.model, hasImageInput)
        : input.prompt.trim();
      const error = validateVideoParameters({
        prompt, durationSeconds: input.durationSeconds, aspectRatio: input.aspectRatio,
        resolution: input.resolution, generateAudio: input.generateAudio,
        firstFrame: Boolean(input.firstFramePath), lastFrame: Boolean(input.lastFramePath),
        images: input.referenceImagePaths.length + Number(Boolean(input.firstFramePath)) + Number(Boolean(input.lastFramePath)),
        videos: new Set([input.sourceVideoPath, ...(input.referenceVideoPaths ?? [])].filter(Boolean)).size,
        audios: input.referenceAudioPaths?.length ?? 0,
        ...(input.mode === "remix" || input.mode === "extend" ? { mode: input.mode } : {})
      }, option);
      if (error) throw new ProviderError("INVALID_REQUEST", error);
      return { ...resolved, prompt };
    };
    const candidates: ReturnType<typeof validateChannel>[] = [];
    if (route) {
      let channelError: unknown;
      for (const channel of videoRouteChannels(route, current.videoProviders)) {
        if (hasMediaInput && channel.provider.type === "seedance-aipai") continue;
        try {
          const resolved = providerConfig({ ...input, providerId: channel.providerId, model: channel.model });
          if (resolved.config.provider === "official" || !resolved.config.apiKey) continue;
          candidates.push(validateChannel(resolved, channel.option));
        } catch (error) {
          channelError ??= error;
        }
      }
      if (!candidates.length) throw channelError ?? new ProviderError("INVALID_CONFIG", hasMediaInput
        ? "该视频模型没有可用的本地参考素材渠道。" : "该视频模型没有配置可用渠道。");
    } else {
      const resolved = providerConfig(input);
      candidates.push(validateChannel(resolved, await videoService.modelOption(resolved.config)));
    }
    const first = candidates[0];
    if (input.boardId && input.generationNodeId) {
      const board = await boards.getBoard(input.boardId);
      if (!board?.nodes.some((node) => node.id === input.generationNodeId && isBoardVideoGenerationNode(node))) {
        throw new ProviderError("INVALID_REQUEST", "视频生成节点不存在。");
      }
      if (targetsVideoVersion(input) && !board.nodes.some((node) => node.id === input.targetVideoNodeId && isBoardVideoNode(node))) {
        throw new ProviderError("INVALID_REQUEST", "要追加版本的目标视频节点不存在。");
      }
    } else if (targetsVideoVersion(input)) {
      throw new ProviderError("INVALID_REQUEST", "追加视频版本需要画板和视频生成节点。");
    }
    const created: VideoGenerationJob = {
      id: crypto.randomUUID(),
      status: "submitting",
      createdAt: new Date().toISOString(),
      input: { ...input, prompt: first.prompt, providerId: route ? undefined : first.providerId },
      providerId: first.providerId,
      providerName: first.providerName,
      model: first.config.model
    };
    let submitting = created;
    activeSubmissions.add(created.id);
    try {
      await videoTasks.addJob(created);
      if (input.boardId && input.generationNodeId && !targetsVideoVersion(input)) {
        await boards.startVideoGenerationNode(input.boardId, input.generationNodeId, {
          jobId: created.id,
          status: "submitting"
        });
      }
      const frameInputs = await Promise.all([
        ...(input.firstFramePath ? [{ imagePath: input.firstFramePath, role: "first-frame" as const }] : []),
        ...(input.lastFramePath ? [{ imagePath: input.lastFramePath, role: "last-frame" as const }] : [])
      ].map(async ({ imagePath, role }, index) => ({
        id: `frame-${index + 1}`,
        kind: "image" as const,
        role,
        mimeType: mimeFromExtension(imagePath),
        name: path.basename(imagePath),
        bytes: await assets.readManagedBytes(imagePath)
      })));
      const referenceInputs = await Promise.all(input.referenceImagePaths.map(async (imagePath, index) => ({
        id: `image-${index + 1}`,
        kind: "image" as const,
        role: "reference-image" as const,
        mimeType: mimeFromExtension(imagePath),
        name: path.basename(imagePath),
        bytes: await assets.readManagedBytes(imagePath)
      })));
      const sourceVideoPaths = [
        ...(input.sourceVideoPath ? [input.sourceVideoPath] : []),
        ...(input.referenceVideoPaths ?? [])
      ].filter((value, index, values) => values.indexOf(value) === index);
      const videoInputs = await Promise.all(sourceVideoPaths.map(async (videoPath, index) => ({
        id: `video-${index + 1}`,
        kind: "video" as const,
        role: "reference-video" as const,
        mimeType: videoMimeFromExtension(videoPath),
        name: path.basename(videoPath),
        bytes: await assets.readManagedBytes(videoPath)
      })));
      const audioInputs = await Promise.all((input.referenceAudioPaths ?? []).map(async (audioPath, index) => ({
        id: `audio-${index + 1}`,
        kind: "audio" as const,
        role: "reference-audio" as const,
        mimeType: audioMimeFromExtension(audioPath),
        name: path.basename(audioPath),
        bytes: await assets.readManagedBytes(audioPath)
      })));
      for (const [index, candidate] of candidates.entries()) {
        if (index > 0) {
          submitting = {
            ...created, providerId: candidate.providerId, providerName: candidate.providerName, model: candidate.config.model
          };
          await videoTasks.updateJob(submitting);
        }
        let task: VideoRemoteTask;
        try {
          task = await videoService.submit({
            clientRequestId: input.generationAttemptId ?? input.idempotencyKey ?? (route ? created.id : undefined),
            prompt: candidate.prompt,
            mode: input.mode,
            model: candidate.config.model,
            ratio: input.aspectRatio,
            resolution: input.resolution,
            durationSeconds: input.durationSeconds,
            generateAudio: input.generateAudio,
            watermark: input.watermark,
            inputs: [...frameInputs, ...referenceInputs, ...videoInputs, ...audioInputs]
          }, candidate.config);
        } catch (error) {
          const normalized = normalizeProviderError(error);
          if (index < candidates.length - 1 && (normalized.code === "CHANNEL_UNAVAILABLE"
            || isRetryableTextChannelRejection(normalized.status))) continue;
          throw error;
        }
        const queued: VideoGenerationJob = {
          ...submitting,
          status: jobStatus(task.status),
          remoteTaskId: task.id,
          remoteStatusUrl: task.statusUrl,
          remoteResponseUrl: task.responseUrl,
          remoteCancelUrl: task.cancelUrl
        };
        await videoTasks.updateJob(queued);
        startBackgroundRun(queued, task, candidate.config);
        return queued;
      }
      throw new ProviderError("INVALID_CONFIG", "该视频模型没有配置可用渠道。");
    } catch (error) {
      const normalized = normalizeProviderError(error);
      const unknown = route && normalized.code !== "CHANNEL_UNAVAILABLE"
        && (["TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE"].includes(normalized.code)
        || (normalized.status ?? 0) >= 500);
      return await finishFailedJob(submitting, unknown
        ? "视频提交状态未确认。请先核对原渠道的任务记录，再决定是否重试。"
        : normalized.message);
    } finally {
      activeSubmissions.delete(created.id);
    }
  };
  ipcMain.handle("video:start", (_event, input: VideoGenerationInput) => {
    const key = input?.idempotencyKey;
    if (key && pendingVideoStarts.has(key)) return pendingVideoStarts.get(key)!;
    const promise = startVideo(_event, input).finally(() => { if (key) pendingVideoStarts.delete(key); });
    if (key) pendingVideoStarts.set(key, promise);
    return promise;
  });
  const recoverJobs = async (): Promise<VideoGenerationJob[]> => {
    const allJobs = await videoTasks.listJobs();
    const reconciled: VideoGenerationJob[] = [];
    for (const job of allJobs) {
      if (job.status === "submitting" && !job.remoteTaskId && !activeSubmissions.has(job.id)) {
        // A submission may have finished since the recovery snapshot was read.
        const latest = await videoTasks.getJob(job.id);
        if (latest?.status === "submitting" && !latest.remoteTaskId && !activeSubmissions.has(job.id)) {
          reconciled.push(await finishFailedJob(
            latest,
            "视频提交已中断，未获取远端任务 ID，无法确认服务商是否已接收。请先核对服务商任务记录和费用，再决定是否重试。"
          ));
        }
        continue;
      }
      if (!job.input.boardId || !job.input.generationNodeId || targetsVideoVersion(job.input)) continue;
      if (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled") continue;
      const board = await boards.getBoard(job.input.boardId);
      const generation = board?.nodes.find((node) => (
        node.id === job.input.generationNodeId && isBoardVideoGenerationNode(node)
      ));
      if (!generation || !isBoardVideoGenerationNode(generation) || generation.lastGenerationId !== job.id) continue;
      if (job.status === "completed" && job.outputVideoPath) {
        await boards.finishVideoGenerationNode(job.input.boardId, job.input.generationNodeId, {
          jobId: job.id,
          node: {
            id: `video-output-${job.id}`,
            type: "video",
            videoPath: job.outputVideoPath,
            posterPath: job.outputPosterPath,
            jobId: job.id,
            source: "generated",
            mimeType: job.mimeType,
            width: job.width,
            height: job.height,
            aspectRatio: job.input.aspectRatio,
            durationMs: job.durationMs,
            generationNodeId: job.input.generationNodeId
          }
        });
        reconciled.push(job);
      } else if (job.status === "failed" || job.status === "cancelled") {
        await boards.startVideoGenerationNode(job.input.boardId, job.input.generationNodeId, {
          jobId: job.id,
          status: "generating"
        });
        await boards.finishVideoGenerationNode(job.input.boardId, job.input.generationNodeId, {
          jobId: job.id,
          error: job.error || (job.status === "cancelled" ? "视频任务已取消。" : "视频生成失败。")
        });
        reconciled.push(job);
      }
    }
    const reconciledIds = new Set(reconciled.map((job) => job.id));
    const candidates = (await videoTasks.listJobs()).filter((job) => (
      !reconciledIds.has(job.id)
      && Boolean(job.remoteTaskId)
      && ["submitting", "queued", "generating", "post_processing", "recovering"].includes(job.status)
    ));
    const resumed: VideoGenerationJob[] = [...reconciled];
    for (const job of candidates) {
      if (!job.remoteTaskId) continue;
      if (job.input.boardId && job.input.generationNodeId && !targetsVideoVersion(job.input)) {
        await boards.startVideoGenerationNode(job.input.boardId, job.input.generationNodeId, {
          jobId: job.id,
          status: job.status === "queued" ? "queued" : "generating"
        });
      }
      if (activeRuns.has(job.id)) {
        resumed.push(job);
        continue;
      }
      try {
        const resolved = providerConfig({ ...job.input, providerId: job.providerId, model: job.model });
        const recovering = { ...job, status: "recovering" as const, error: undefined };
        await videoTasks.updateJob(recovering);
        startBackgroundRun(recovering, remoteTaskFromJob(job), resolved.config);
        resumed.push(recovering);
      } catch (error) {
        const recovering = { ...job, status: "recovering" as const, error: normalizeProviderError(error).message };
        await videoTasks.updateJob(recovering);
        resumed.push(recovering);
      }
    }
    return resumed;
  };
  let recovery: Promise<VideoGenerationJob[]> | undefined;
  const recover = (): Promise<VideoGenerationJob[]> => {
    if (!recovery) recovery = recoverJobs().finally(() => { recovery = undefined; });
    return recovery;
  };
  ipcMain.handle("video:recover", recover);
  ipcMain.handle("video:stopPolling", async (_event, jobId: string) => {
    const run = activeRuns.get(jobId);
    run?.controller.abort();
    return { stopped: Boolean(run), job: await videoTasks.getJob(jobId) };
  });
  ipcMain.handle("video:save", async (_event, sourcePath: string) => {
    assets.toAssetUrl(sourcePath);
    const result = await dialog.showSaveDialog({
      defaultPath: path.basename(sourcePath),
      filters: [{ name: "视频", extensions: [path.extname(sourcePath).slice(1) || "mp4"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    await assets.exportAsset(sourcePath, result.filePath);
    return { ok: true, path: result.filePath };
  });
  ipcMain.handle("video:reveal", async (_event, sourcePath: string) => {
    await assets.readManagedBytes(sourcePath);
    shell.showItemInFolder(sourcePath);
    return { ok: true };
  });

  return {
    recover,
    dispose: () => {
      for (const run of activeRuns.values()) run.controller.abort();
      activeRuns.clear();
    },
    stopBoard: async (boardId: string) => {
      const jobs = (await videoTasks.listJobs()).filter((job) => job.input.boardId === boardId);
      const runs = jobs.flatMap((job) => {
        const run = activeRuns.get(job.id);
        if (!run) return [];
        run.controller.abort();
        return [run.promise];
      });
      await Promise.allSettled(runs);
    }
  };
}

