import { expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CompanyToapis,
  toapisDimensions,
  resolveToapisSize,
  type ToapisRunner,
} from "../electron/company/toapis.js";
import type { ProviderGenerateInput } from "../shared/types.js";
const credential = {
  schemaVersion: 1 as const,
  site: "cn" as const,
  apiKey: "fixture-private-key",
};
it("imports only into the account namespace and recovers the same paid request without resubmitting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-toapis-test-"));
  const calls: string[][] = [];
  const runner: ToapisRunner = async (args, config) => {
    calls.push(args);
    expect(config).toContain(path.join(root, "employee-A", "credentials"));
    if (args[0] === "auth") {
      expect(JSON.parse(await readFile(args[3], "utf8"))).toEqual(credential);
      await writeFile(
        path.join(config, "credentials.json"),
        JSON.stringify({
          apiKey: credential.apiKey,
          site: credential.site,
          schemaVersion: 1,
        }),
        { flag: "wx", mode: 0o600 },
      );
      return { ok: true };
    }
    const out =
      args[0] === "image"
        ? args[args.indexOf("--out-directory") + 1]
        : args[args.indexOf("--directory") + 1];
    await mkdir(out, { recursive: true });
    const file = path.join(out, "image-1.png");
    await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    return {
      ok: true,
      result: { state: "succeeded" },
      artifacts: [{ path: file }],
    };
  };
  try {
    const adapter = new CompanyToapis(
      root,
      () => ({
        namespace: "employee-A",
        image: {
          enabled: true,
          credential,
          models: ["gpt-image-2.6-sunburst"],
        },
      }),
      runner,
    );
    const input: ProviderGenerateInput = {
      clientRequestId: "same-request",
      workflowMode: "generate",
      prompt: "生成一张图",
      model: "gpt-image-2.6-sunburst",
      size: "9:16",
      n: 1,
      referenceImages: [],
    };
    expect((await adapter.generate(input)).images).toHaveLength(1);
    expect((await adapter.generate(input)).images).toHaveLength(1);
    const restarted = new CompanyToapis(
      root,
      () => ({
        namespace: "employee-A",
        image: {
          enabled: true,
          credential,
          models: ["gpt-image-2.6-sunburst"],
        },
      }),
      runner,
    );
    expect((await restarted.generate(input)).images).toHaveLength(1);
    expect(calls.filter((a) => a[0] === "auth")).toHaveLength(1);
    expect(calls.filter((a) => a[0] === "image")).toHaveLength(1);
    const submitted = calls.find(a => a[0] === "image")!;
    expect(submitted[submitted.indexOf("--aspect") + 1]).toBe("9:16");
    expect(submitted[submitted.indexOf("--resolution") + 1]).toBe("2K");
    expect(calls.at(-1)?.slice(0, 2)).toEqual(["task", "wait"]);
    await expect(
      adapter.generate({ ...input, prompt: "另一个请求" }),
    ).rejects.toThrow("其他参数");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("preserves requested aspect and rejects unsupported 4K Seedream", () => {
  expect(toapisDimensions("2048x1152", "gpt-image-2.6-sunburst")).toEqual({
    resolution: "2K",
    aspect: "16:9",
  });
  expect(() => toapisDimensions("3840x2160", "doubao-seedream-5-5")).toThrow(
    "最高",
  );
});

it.each(["9:16", "16:9", "18:32"])("accepts Agent aspect %s without changing the requested frame", (size) => {
  expect(toapisDimensions(size, "gpt-image-2.6-sunburst")).toEqual({resolution: "2K", aspect: size === "16:9" ? "16:9" : "9:16"});
});
it.each(["0:16", "9:0", "invalid", "9007199254740993x2048", "5:7"])("reports pre-submission dimension failure for %s", size => {
  expect(() => toapisDimensions(size, "gpt-image-2.6-sunburst")).toThrow(expect.objectContaining({code: "TOAPIS_INPUT_INVALID", status: 400}));
});

it("preserves the source ratio for auto edits and respects explicit size",()=>{
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write("IHDR",12,"ascii");png.writeUInt32BE(1086,16);png.writeUInt32BE(1448,20);
 const input={workflowMode:"edit" as const,size:"auto",referenceImages:[{name:"source",mimeType:"image/png",bytes:png}]};
 expect(resolveToapisSize(input)).toBe("3:4");
 expect(toapisDimensions(resolveToapisSize(input),"gemini-nano-banana-2.1").aspect).toBe("3:4");
 expect(resolveToapisSize({...input,size:"16:9"})).toBe("16:9");
 expect(resolveToapisSize({...input,workflowMode:"generate"})).toBe("auto");
 expect(()=>resolveToapisSize({...input,referenceImages:[{...input.referenceImages[0],bytes:Buffer.from("bad")}]})).toThrow("明确指定输出画幅");
});
