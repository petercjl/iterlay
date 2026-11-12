import { expect, it } from "vitest";
import { executionSpace, inExecutionSpace, setSelectedSpaceResolver } from "../electron/execution-space.js";
import type { SpaceKind } from "../shared/enterprise.js";

it("pins in-flight settings and nested operations while the selected UI space changes", async () => {
  let selected: SpaceKind = "personal";
  setSelectedSpaceResolver(() => selected);
  let resume!: () => void;
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  const task = inExecutionSpace(async () => { await barrier; return inExecutionSpace(() => executionSpace()); });
  selected = "enterprise";
  expect(executionSpace()).toBe("enterprise");
  resume(); expect(await task).toBe("personal");
  setSelectedSpaceResolver(() => "personal");
});
