import { describe, expect, it } from "vitest";
import { buildStartupPage } from "../electron/startup-page";

describe("startup page", () => {
  it("renders the branded loading state without application dependencies", () => {
    const html = buildStartupPage({ dark: false });
    expect(html).toContain('role="status"');
    expect(html).toContain("Tuda");
    expect(html).toContain('viewBox="0 0 1024 1024"');
    expect(html).toContain("#00C8AE");
    expect(html).toContain("background:#fafafa");
  });

  it("matches the dark BrowserWindow background", () => {
    const html = buildStartupPage({ dark: true });
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("background:#121212");
  });

  it("renders localized assistive loading copy", () => {
    const html = buildStartupPage({ dark: false, locale: "en-US" });
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Opening Tuda");
    expect(html).not.toContain("正在打开");
  });
});
