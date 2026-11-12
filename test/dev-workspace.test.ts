import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDesktopDevelopmentUserData } from "../electron/dev-workspace.js";

describe("desktop development workspace isolation", () => {
  const base = { isPackaged: false, isBrowserDev: false, appPath: path.resolve("fixture-app"), env: {} };

  it("uses a project-local workspace for ordinary desktop development", () => {
    expect(resolveDesktopDevelopmentUserData(base)).toBe(path.join(base.appPath, "tmp", "desktop-dev", "user-data"));
  });

  it("supports an explicitly selected desktop development directory", () => {
    expect(resolveDesktopDevelopmentUserData({ ...base, env: { ITERLAY_DESKTOP_DEV_USER_DATA: " ./custom-dev " } }))
      .toBe(path.resolve("custom-dev"));
  });

  it("retains the isolated workspace selected by desktop lifecycle tests", () => {
    expect(resolveDesktopDevelopmentUserData({ ...base, env: {
      ITERLAY_PLAYWRIGHT: "1", ITERLAY_E2E_USER_DATA: "./test-data", ITERLAY_DESKTOP_DEV_USER_DATA: "./dev-data"
    } })).toBe(path.resolve("test-data"));
  });

  it("ignores inactive test settings", () => {
    expect(resolveDesktopDevelopmentUserData({ ...base, env: { ITERLAY_E2E_USER_DATA: "./test-data" } }))
      .toBe(path.join(base.appPath, "tmp", "desktop-dev", "user-data"));
  });

  it("leaves packaged applications on their operating-system user workspace", () => {
    expect(resolveDesktopDevelopmentUserData({ ...base, isPackaged: true, env: {
      ITERLAY_PLAYWRIGHT: "1", ITERLAY_E2E_USER_DATA: "./test-data", ITERLAY_DESKTOP_DEV_USER_DATA: "./dev-data"
    } })).toBeUndefined();
  });

  it("leaves browser workspace selection to the browser launcher", () => {
    expect(resolveDesktopDevelopmentUserData({ ...base, isBrowserDev: true })).toBeUndefined();
  });
});
