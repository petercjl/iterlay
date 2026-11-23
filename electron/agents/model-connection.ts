import type { Api, Model, Provider, ModelAuth, StreamFunction, SimpleStreamOptions, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createProvider, lazyApi, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableTextChannelRejection } from "../providers/errors.js";

/** Credentials are resolved by Tuda, never copied to Pi's auth.json or session files. */
export interface TudaModelConnection {
  id: string;
  name: string;
  model: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "openai-codex-responses";
  baseUrl: string;
  getAuth: () => Promise<ModelAuth>;
  fetch?: typeof fetch;
  fallbacks?: TudaModelConnection[];
}

function connectionModel(connection: TudaModelConnection): Model<Api> {
  return {
    id: connection.model, name: connection.model, provider: connection.id,
    api: connection.api, baseUrl: connection.baseUrl,
    input: ["text", "image"], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 16_384,
    ...(connection.api === "openai-completions" ? { compat: { supportsDeveloperRole: false, supportsStore: false } } : {})
  };
}

function connectionApi(api: TudaModelConnection["api"]) {
  return lazyApi(async () => {
    switch (api) {
      case "anthropic-messages": return import("@earendil-works/pi-ai/api/anthropic-messages");
      case "openai-responses": return import("@earendil-works/pi-ai/api/openai-responses");
      case "openai-codex-responses": return import("@earendil-works/pi-ai/api/openai-codex-responses");
      default: return import("@earendil-works/pi-ai/api/openai-completions");
    }
  });
}

export function createTudaModelProvider(connection: TudaModelConnection): { provider: Provider; model: Model<Api> } {
  const model = connectionModel(connection);
  const channels = [connection, ...connection.fallbacks ?? []].map(candidate => ({
    candidate, model: connectionModel(candidate), implementation: connectionApi(candidate.api)
  }));
  // Once a reply starts, its subsequent tool turns stay on the same upstream channel.
  let selected = 0;
  let pinned = false;
  function withRouting(method: "stream" | "streamSimple"): StreamFunction<Api, SimpleStreamOptions> {
    return (m, context, options) => {
      if (channels.length === 1) {
        return channels[0].implementation[method](m, context, { ...options, fetch: connection.fetch ?? options?.fetch });
      }
      const output = createAssistantMessageEventStream();
      void (async () => {
        let lastRejection: Extract<AssistantMessageEvent, { type: "error" }> | undefined;
        for (let index = selected; index < channels.length; index++) {
          const { candidate, implementation, model: upstreamModel } = channels[index];
          if (options?.signal?.aborted && lastRejection) break;
          let httpStatus: number | undefined;
          const fetchImpl = candidate.fetch ?? options?.fetch ?? fetch;
          const observedFetch: typeof fetch = async (input, init) => {
            const response = await fetchImpl(input, init);
            httpStatus = response.status;
            return response;
          };
          const auth = index === 0 ? undefined : await candidate.getAuth();
          const stream = implementation[method](index === 0 ? m : upstreamModel, context, {
            ...options, fetch: observedFetch, maxRetries: 0,
            // Apply only this channel's credentials and auth headers after switching.
            ...(auth ? { apiKey: auth.apiKey, headers: auth.headers } : {})
          });
          let start: AssistantMessageEvent | undefined;
          let alternate = false;
          for await (const event of stream) {
            if (event.type === "start") { start = event; continue; }
            if (!pinned && !options?.signal?.aborted && event.type === "error" &&
                isRetryableTextChannelRejection(httpStatus) && index + 1 < channels.length) {
              lastRejection = event;
              alternate = true;
              break;
            }
            selected = index;
            if (event.type !== "error") pinned = true;
            if (start) { output.push(start); start = undefined; }
            output.push(event);
          }
          if (!alternate) { output.end(await stream.result()); return; }
        }
        if (lastRejection) output.push(lastRejection);
        output.end();
      })().catch(() => {
        output.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], provider: model.provider, model: model.id, api: model.api,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error", errorMessage: "文本模型渠道不可用。", timestamp: Date.now()
        } });
      });
      return output;
    };
  }
  const provider = createProvider({
    id: connection.id, name: connection.name, baseUrl: connection.baseUrl, models: [model],
    auth: { apiKey: { name: "Tuda managed authorization", resolve: async () => ({ auth: await connection.getAuth() }) } },
    api: {
      stream: withRouting("stream"),
      streamSimple: withRouting("streamSimple")
    }
  });
  return { provider, model };
}
