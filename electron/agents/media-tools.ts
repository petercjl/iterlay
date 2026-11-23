import type { ToolDefinition } from "./coding-runtime.js";
import type { ProviderConfig } from "../../shared/types.js";
import { resolveAgentImageProvider } from "../../shared/tuda-models.js";

/** Tuda owns media routing; Pi executes the tool with the user's selected model. */
export function bindTudaAgentMediaTools(tools: ToolDefinition[], providers: ProviderConfig[]): ToolDefinition[] {
  return tools.map((tool) => {
    if (tool.name === "generate_video") {
      const schema = tool.parameters as { properties?: Record<string, unknown> };
      const properties = { ...schema.properties };
      delete properties.providerId;
      delete properties.firstFramePath;
      delete properties.lastFramePath;
      return {
        ...tool,
        parameters: { ...tool.parameters, properties },
        description: "生成视频并添加到画板。model 使用用户在设置中配置的模型名称，省略时使用默认模型。引用画板图片时优先使用 referenceNodeIds，其他全能参考使用 referenceImagePaths、referenceVideoPaths 和 referenceAudioPaths。仅使用用户指定的参考素材，纯文字生成设置 textOnly=true。提交后通过原任务 ID 查询结果。",
        execute: async (id, raw, signal, update, context) => {
          const args = { ...(raw as Record<string, unknown>) };
          delete args.providerId;
          return tool.execute(id, { ...args, useVideoRouting: true }, signal, update, context);
        }
      } as ToolDefinition;
    }
    if (tool.name === "generate_image") {
      const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
      const properties = { ...schema.properties };
      delete properties.providerId;
      return {
        ...tool,
        parameters: { ...tool.parameters, properties, required: (schema.required ?? []).filter(key => key !== "model" && key !== "providerId") },
        description: "生成图片并添加到画板。提供提示词、画板和必要参数。省略 model 时使用用户配置的 Agent 默认生图模型，Tuda 自动按渠道顺序提交。返回 generationId 后查询原任务。若状态未知，等待核对，避免发起重复任务。",
        execute: async (id, raw, signal, update, context) => {
          const args = { ...(raw as Record<string, unknown>) };
          delete args.providerId;
          return tool.execute(id, { ...args, useImageRouting: true }, signal, update, context);
        }
      } as ToolDefinition;
    }
    if (tool.name !== "edit_image") return tool;
    const schema = tool.parameters as { required?: string[] };
    return {
      ...tool,
      description: `${tool.description}\n用 list_providers 查询可用的服务和模型。model 必须来自用户在对话中的选择。同名模型按用户指定的服务传入 providerId，用户尚未指定时先询问。`,
      parameters: { ...tool.parameters, required: [...new Set([...schema.required ?? [], "model"])] },
      execute: async (id, raw, signal, update, context) => {
        const args = raw as Record<string, unknown>;
        const provider = resolveAgentImageProvider(providers, args.model, args.providerId);
        return tool.execute(id, { ...args, providerId: provider.id }, signal, update, context);
      }
    } as ToolDefinition;
  });
}
