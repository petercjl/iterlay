import { expect, it } from "vitest";
import { executionSpace, setSelectedSpaceResolver } from "../electron/execution-space";
import { workspaceFixture } from "./helpers/workspace-fixture";
import { listWorkspaceTools } from "../electron/workspace-tools";

it("discovers space status without exposing session tokens and explicitly selects a space", async () => {
  const f = workspaceFixture();
  f.mocks.enterpriseStatus.mockResolvedValue({ activeSpace: "enterprise", authenticated: true, pendingWrites: 0 });
  expect(await f.commands.call("get_space", {})).toEqual({ activeSpace: "enterprise", authenticated: true, pendingWrites: 0 });
  await f.commands.call("select_space", { target: "personal" });
  expect(f.mocks.selectSpace).toHaveBeenCalledWith("personal");
  expect(listWorkspaceTools().some(tool => tool.name === "get_space")).toBe(true);
});

it("pins an explicit operation space across awaits without changing the selected desktop space", async () => {
  setSelectedSpaceResolver(() => "personal");
  const f = workspaceFixture();
  f.mocks.moveBoardImage.mockImplementation(async () => { await Promise.resolve(); expect(executionSpace()).toBe("enterprise"); });
  await f.commands.call("move_image", { space: "enterprise", boardId: "board", nodeId: "image", x: 10, y: 20 });
  expect(executionSpace()).toBe("personal");
  await expect(f.commands.call("list_boards", { space: "other" })).rejects.toThrow("无效空间");
});
