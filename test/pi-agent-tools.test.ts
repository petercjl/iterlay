import { describe, expect, it, vi } from "vitest";
import { createTudaAgentTools } from "../electron/pi-agent-tools.js";

describe("Tuda Pi Agent tools", () => {
  it("exposes the complete Tuda workspace tool catalog", () => {
    const tools = createTudaAgentTools("/tmp/tuda", {}, vi.fn());
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_active_board",
      "get_board",
      "arrange_images",
      "trash_images",
      "generate_image",
      "edit_image",
      "generate_video",
      "get_video_generation_status",
      "export_assets"
    ]));
    expect(tools.map((tool) => tool.name)).toContain("list_providers");
  });

  it.each(["generate_image", "edit_image"])("exposes and forwards transparent PNG requests through %s", async (name) => {
    const callBridge = vi.fn(async () => ({ generationId: "transparent-task" }));
    const tool = createTudaAgentTools("/tmp/tuda", { boardId: "board-1" }, callBridge)
      .find((candidate) => candidate.name === name)!;
    expect(tool.parameters).toMatchObject({ properties: {
      background: { type: "string", enum: ["auto", "opaque", "transparent"] }
    } });
    const args = { boardId: "board-1", prompt: "Isolate the subject", sourcePath: "/managed/source.png",
      model: "gpt-image-2.5-sunburst", background: "transparent" };
    await tool.execute("transparent-call", args);
    expect(callBridge).toHaveBeenCalledWith("/tmp/tuda", name, args);
    expect(tool.description).not.toContain("falls back");
  });

  it("routes tool calls through the local workspace service", async () => {
    const callBridge = vi.fn(async () => ({ boardId: "board-1", nodeCount: 2 }));
    const tool = createTudaAgentTools("/tmp/tuda", { boardId: "board-1" }, callBridge)
      .find((candidate) => candidate.name === "get_board");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call-1", { boardId: "board-1" });

    expect(callBridge).toHaveBeenCalledWith("/tmp/tuda", "get_board", { boardId: "board-1" });
    expect(result.content).toEqual([{
      type: "text",
      text: JSON.stringify({ boardId: "board-1", nodeCount: 2 })
    }]);
  });

  it("keeps creation tools in the current view without changing normal CLI calls", async () => {
    const callBridge = vi.fn(async () => ({ id: "new-board" }));
    const tool = createTudaAgentTools("/tmp/tuda", { preserveView: true }, callBridge)
      .find((candidate) => candidate.name === "create_board")!;
    await tool.execute("create", { name: "创作" });
    expect(callBridge).toHaveBeenCalledWith("/tmp/tuda", "create_board", { name: "创作", preserveView: true });
  });

  it("retains the user's attached board image when the model emits an empty reference list", async () => {
    const callBridge = vi.fn(async () => ({ id: "video" }));
    const tool = createTudaAgentTools("/tmp/tuda", { boardId: "board-1",
      referenceImagePaths: ["/managed/attached.png"], referenceNodeIds: ["attached"] }, callBridge)
      .find((candidate) => candidate.name === "generate_video")!;
    await tool.execute("video", { boardId: "board-1", prompt: "animate this", referenceImagePaths: [] });
    expect(callBridge).toHaveBeenCalledWith("/tmp/tuda", "generate_video", expect.objectContaining({
      referenceImagePaths: ["/managed/attached.png"], referenceNodeIds: ["attached"]
    }));
  });
  it("blocks board mutations outside the active board", async () => {
    const callBridge = vi.fn();
    const tool = createTudaAgentTools("/tmp/tuda", { boardId: "board-1" }, callBridge)
      .find((candidate) => candidate.name === "trash_images");

    await expect(tool!.execute("call-2", {
      boardId: "board-2",
      nodeIds: ["node-1"]
    })).rejects.toThrow("只能操作当前画板 board-1");
    expect(callBridge).not.toHaveBeenCalled();
  });
});
