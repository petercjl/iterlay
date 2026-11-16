import { describe, expect, it } from "vitest";
import { desktopLaunchPlan } from "../scripts/launch-desktop-dev.mjs";

describe("desktop dev relaunch", () => {
  const root = "/workspace/Tuda Project";
  const command = "node /workspace/Tuda Project/node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5180 --strictPort";
  it("starts services when the port is free", () => {
    expect(desktopLaunchPlan(root, [])).toBe("start");
  });
  it("reuses this project's Vite after the desktop exits", () => {
    expect(desktopLaunchPlan(root, [{ cwd: root, command }])).toBe("reuse");
  });
  it("rejects another project's Vite and unrelated port owners", () => {
    expect(() => desktopLaunchPlan(root, [{ cwd: "/another-project", command }])).toThrow("5180");
    expect(() => desktopLaunchPlan(root, [{ cwd: root, command: "node server.js" }])).toThrow("5180");
    expect(() => desktopLaunchPlan(root, [{ cwd: root, command }, { cwd: root, command: "other" }])).toThrow("5180");
  });
});
