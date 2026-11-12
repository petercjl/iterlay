import { describe, expect, it } from "vitest";
import { extractTudaDeepLinks, parseTudaDeepLink } from "../shared/deep-link.js";

describe("parseTudaDeepLink", () => {
  it("opens a board node in edit mode with a prompt", () => {
    const result = parseTudaDeepLink(
      "tuda://boards/board-1/nodes/node-2?view=edit&prompt=%E6%8D%A2%E6%88%90%E7%BA%A2%E8%89%B2"
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "board",
        boardId: "board-1",
        nodeId: "node-2",
        view: "edit",
        prompt: "换成红色"
      }
    });
  });

  it("uses templates as the canonical domain while accepting the scenes alias", () => {
    expect(parseTudaDeepLink("tuda://templates/preset%3Aad-poster")).toMatchObject({
      ok: true,
      value: { kind: "template", templateId: "preset:ad-poster", action: "preview" }
    });
    expect(parseTudaDeepLink("tuda://scenes/custom-1?action=apply")).toMatchObject({
      ok: true,
      value: { kind: "template", templateId: "custom-1", action: "apply" }
    });
  });

  it("parses compose links without exposing files or payload bytes", () => {
    expect(
      parseTudaDeepLink(
        "tuda://compose?boardId=board-1&templateId=preset%3Aproduct&prompt=packaging"
      )
    ).toMatchObject({
      ok: true,
      value: {
        kind: "compose",
        boardId: "board-1",
        templateId: "preset:product",
        prompt: "packaging",
        mode: "generate"
      }
    });
  });

  it("parses a public share import link without placing image bytes in the URL", () => {
    expect(parseTudaDeepLink("tuda://import?source=https%3A%2F%2Fshare.example%2Fabc%2F")).toMatchObject({
      ok: true,
      value: { kind: "import", source: "https://share.example/abc/" }
    });
  });

  it("rejects unsupported paths, values and protocol versions", () => {
    expect(parseTudaDeepLink("https://example.com")).toMatchObject({ ok: false });
    expect(parseTudaDeepLink("tuda://boards/a/nodes/b?view=delete")).toMatchObject({ ok: false });
    expect(parseTudaDeepLink("tuda://boards?v=2")).toMatchObject({ ok: false });
    expect(parseTudaDeepLink("tuda://compose")).toMatchObject({ ok: false });
    expect(parseTudaDeepLink("tuda://import?source=file%3A%2F%2F%2Ftmp%2Fshare")).toMatchObject({ ok: false });
    expect(parseTudaDeepLink("tuda://boards/a/nodes/node%2Fchild")).toMatchObject({ ok: false });
  });

  it("extracts protocol arguments from a second-instance argv", () => {
    expect(
      extractTudaDeepLinks([
        "/Applications/Tuda.app/Contents/MacOS/Tuda",
        "--flag",
        "tuda://boards/board-1",
        "TUDA://assets"
      ])
    ).toEqual(["tuda://boards/board-1", "TUDA://assets"]);
  });
});
