import type { TextProviderConfig } from "../../shared/types.js";
import type { TextCompletionOptions } from "./text-assistant.js";

type Message = {
  role: string;
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url: string } }>;
};
/** Adapt the harness's messages, including visual references, to the declared wire protocol. */
export function nativeTextRequest(
  config: TextProviderConfig,
  messages: readonly unknown[],
  opts: TextCompletionOptions,
  stream: boolean,
) {
  const input = messages as Message[];
  if (
    input.some((m) => !m || !["system", "user", "assistant"].includes(m.role))
  )
    throw new Error("文本协议不支持该消息类型。");
  const anthropic = config.protocol === "anthropic-messages";
  const blocks = (content: Message["content"], role: string) =>
    typeof content === "string"
      ? content
      : content.map((b) => {
          if (b.type === "text" && typeof b.text === "string")
            return {
              type: anthropic
                ? "text"
                : role === "assistant"
                  ? "output_text"
                  : "input_text",
              text: b.text,
            };
          const url = b.image_url?.url;
          if (b.type !== "image_url" || typeof url !== "string")
            throw new Error("文本参考素材格式不受支持。");
          if (!anthropic) return { type: "input_image", image_url: url };
          const match =
            /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
              url,
            );
          if (!match) throw new Error("Anthropic 图片需使用已读取的本地图片。");
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        });
  const system = input
    .filter((m) => m.role === "system")
    .map((m) => {
      if (typeof m.content !== "string")
        throw new Error("系统提示词应为文本。");
      return m.content;
    })
    .join("\n\n");
  const rest = input
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: blocks(m.content, m.role) }));
  return {
    url:
      config.baseUrl.replace(/\/$/, "") +
      (anthropic ? "/messages" : "/responses"),
    body: anthropic
      ? {
          model: config.model,
          system,
          messages: rest,
          max_tokens: opts.maxTokens ?? 4096,
          ...(opts.temperature === undefined
            ? {}
            : { temperature: opts.temperature }),
          stream,
        }
      : {
          model: config.model,
          instructions: system,
          input: rest,
          ...(opts.maxTokens === undefined
            ? {}
            : { max_output_tokens: opts.maxTokens }),
          stream,
        },
  };
}
export function nativeTextContent(
  payload: unknown,
  anthropic: boolean,
): string {
  const p = payload as {
    content?: Array<{ type: string; text?: string }>;
    output?: Array<{
      type: string;
      content?: Array<{ type: string; text?: string }>;
    }>;
    status?: string;
  };
  if (!anthropic && p.status !== "completed")
    throw new Error("文本 Responses 请求未完成。");
  const blocks = anthropic
    ? p.content
    : p.output
        ?.filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? []);
  const text = blocks
    ?.filter((b) => b.type === (anthropic ? "text" : "output_text"))
    .map((b) => b.text ?? "")
    .join("");
  if (!text) throw new Error("文本模型未返回内容。");
  return text;
}
export async function readNativeTextStream(
  response: Response,
  anthropic: boolean,
  onText: (value: string) => void,
  onSummary?: (value: string) => void,
) {
  if (!response.body) throw new Error("文本模型未返回响应流。");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    output = "",
    complete = false;
  const event = (frame: string) => {
    const raw = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!raw || raw === "[DONE]") return;
    const e = JSON.parse(raw) as {
      type: string;
      delta?: string | { type: string; text?: string };
      response?: { status?: string };
    };
    if (
      e.type === "error" ||
      ["response.failed", "response.incomplete"].includes(e.type)
    )
      throw new Error("文本模型流式请求失败。");
    const delta =
      anthropic &&
      e.type === "content_block_delta" &&
      typeof e.delta === "object" &&
      e.delta.type === "text_delta"
        ? e.delta.text
        : !anthropic &&
            e.type === "response.output_text.delta" &&
            typeof e.delta === "string"
          ? e.delta
          : undefined;
    if (delta) {
      output += delta;
      onText(delta);
    }
    if (
      !anthropic &&
      e.type === "response.reasoning_summary_text.delta" &&
      typeof e.delta === "string"
    )
      onSummary?.(e.delta);
    if (
      (anthropic && e.type === "message_stop") ||
      (!anthropic &&
        e.type === "response.completed" &&
        e.response?.status === "completed")
    )
      complete = true;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        event(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (done) break;
    }
    if (buffer.trim()) event(buffer);
    if (!complete || !output)
      throw new Error("文本响应流未完整结束，请保留当前对话后重试。");
    return output;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
