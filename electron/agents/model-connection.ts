import type { Api, Model, Provider, ModelAuth } from "@earendil-works/pi-ai";
import { createProvider, lazyApi } from "@earendil-works/pi-ai";

/** Credentials are resolved by Tuda, never copied to Pi's auth.json or session files. */
export interface TudaModelConnection {
  id: string;
  name: string;
  model: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "openai-codex-responses";
  baseUrl: string;
  getAuth: () => Promise<ModelAuth>;
  fetch?: typeof fetch;
}

export function createTudaModelProvider(connection: TudaModelConnection): { provider: Provider; model: Model<Api> } {
  const model: Model<Api> = {
    id: connection.model, name: connection.model, provider: connection.id,
    api: connection.api, baseUrl: connection.baseUrl,
    input: ["text", "image"], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 16_384,
    ...(connection.api === "openai-completions" ? { compat: { supportsDeveloperRole: false, supportsStore: false } } : {})
  };
  const implementation = lazyApi(async () => {
    switch (connection.api) {
      case "anthropic-messages": return import("@earendil-works/pi-ai/api/anthropic-messages");
      case "openai-responses": return import("@earendil-works/pi-ai/api/openai-responses");
      case "openai-codex-responses": return import("@earendil-works/pi-ai/api/openai-codex-responses");
      default: return import("@earendil-works/pi-ai/api/openai-completions");
    }
  });
  const provider = createProvider({
    id: connection.id, name: connection.name, baseUrl: connection.baseUrl, models: [model],
    auth: { apiKey: { name: "Tuda managed authorization", resolve: async () => ({ auth: await connection.getAuth() }) } },
    api: {
      stream: (m, context, options) => implementation.stream(m, context, { ...options, fetch: connection.fetch ?? options?.fetch }),
      streamSimple: (m, context, options) => implementation.streamSimple(m, context, { ...options, fetch: connection.fetch ?? options?.fetch })
    }
  });
  return { provider, model };
}
