import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({ call: vi.fn(), spawn: vi.fn() }));
vi.mock("../electron/local-api-client.js", () => ({ callLocalApi: mocks.call }));
vi.mock("../cli/src/paths.js", () => ({ resolveTudaApp: async () => ({ commandPath: "/test/Tuda" }) }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { connect } from "../cli/src/runtime.js";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function slowDesktop() {
  vi.useFakeTimers();
  const started = Date.now();
  mocks.call.mockImplementation(async () => {
    if (Date.now() - started < 43000) throw new Error("not ready");
    return { protocolVersion: 1 };
  });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
}
it("accepts a real-world 43-second cold start within an explicit host deadline without replaying mutations", async () => {
  slowDesktop();
  const pending = connect({ userDataPath: "/isolated", startupTimeoutMs: 120000 });
  await vi.advanceTimersByTimeAsync(43250);
  expect(typeof await pending).toBe("function");
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.call.mock.calls.every(call => call[1] === "status")).toBe(true);
});
it("keeps the ordinary CLI default bounded and rejects invalid host deadlines", async () => {
  slowDesktop();
  const pending = connect({ userDataPath: "/isolated" }).catch(error => error);
  await vi.advanceTimersByTimeAsync(30250);
  expect((await pending).message).toContain("后台服务尚未就绪");
  mocks.spawn.mockClear();
  await expect(connect({ userDataPath: "/isolated", startupTimeoutMs: NaN })).rejects.toThrow("INVALID_STARTUP_TIMEOUT");
  expect(mocks.spawn).not.toHaveBeenCalled();
});
