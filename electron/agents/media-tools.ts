import type { ToolDefinition } from "./coding-runtime.js";
import type { ProviderConfig } from "../../shared/types.js";
import { toapisAgentProvider } from "../../shared/tuda-models.js";

/** Tuda owns media routing; Pi executes the tool with the user's selected model. */
export function bindTudaAgentMediaTools(tools: ToolDefinition[], providers: ProviderConfig[]): ToolDefinition[] {
  return tools.map((tool) => {
    if (tool.name !== "generate_image" && tool.name !== "edit_image") return tool;
    const schema = tool.parameters as { required?: string[] };
    return {
      ...tool,
      description: `${tool.description}\n图片通过 ToAPIs 插件执行。model 必须来自用户在对话中的选择；未指定时先询问用户。用 list_providers 查询授权模型，不依赖界面的图片模型设置。`,
      parameters: { ...tool.parameters, required: [...new Set([...schema.required ?? [], "model"])] },
      execute: async (id, raw, signal, update, context) => {
        const args = raw as Record<string, unknown>;
        const provider = toapisAgentProvider(providers, args.model);
        return tool.execute(id, { ...args, providerId: provider.id }, signal, update, context);
      }
    } as ToolDefinition;
  });
}
