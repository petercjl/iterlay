import type { AudioProviderConfig } from "../../shared/contracts/providers.js";
import type { ImageModelRouting } from "../../shared/image-routing.js";
import { isRetryableTextChannelRejection, ProviderError } from "./errors.js";

export async function generateSpeech(
  input: { text: string; model?: string },
  routing: ImageModelRouting | undefined,
  providers: readonly AudioProviderConfig[],
  keyFor: (providerId: string) => string,
  fetcher: typeof fetch = fetch
) {
  const text = input?.text?.trim();
  if (!text || text.length > 4000) throw new Error("请输入 1 至 4000 字的语音内容。");
  const route = routing?.models.find(model => model.name === (input.model?.trim() || routing.defaultModel));
  if (!route) throw new Error("请在模型设置中配置音频模型。");
  const channels = route.channels.flatMap(channel => {
    const provider = providers.find(item => item.id === channel.providerId && item.model === channel.model);
    const key = provider && keyFor(provider.id);
    return provider && key ? [{ provider, key }] : [];
  });
  if (!channels.length) throw new Error("当前音频模型没有可用渠道。");
  for (const [index, { provider, key }] of channels.entries()) {
    const base = provider.baseUrl.replace(/\/$/u, "");
    const endpoint = provider.speechEndpoint.startsWith("/v1/") && base.endsWith("/v1")
      ? provider.speechEndpoint.slice(3) : provider.speechEndpoint;
    const response = await fetcher(base + endpoint, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: provider.model, input: text, voice: provider.voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(90_000)
    });
    if (!response.ok) {
      if (index < channels.length - 1 && isRetryableTextChannelRejection(response.status)) continue;
      throw new ProviderError("SPEECH_REQUEST_FAILED", `音频渠道拒绝请求（HTTP ${response.status}）。`, response.status);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    if (mimeType !== "audio/mpeg" || !bytes.length) throw new Error("音频渠道未返回有效的 MP3。");
    return { bytes, mimeType };
  }
  throw new Error("当前音频模型没有可用渠道。");
}
