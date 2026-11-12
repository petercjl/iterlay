import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import type { CompanyBootstrap } from "../../shared/company-account.js";
import type {
  GenerationResult,
  ProviderGenerateInput,
} from "../../shared/types.js";
import type { ImageProviderAdapter } from "../providers/image-registry.js";

type CliResult = {
  ok: boolean;
  error?: { code?: string };
  artifacts?: Array<{ path: string }>;
  result?: { state?: string };
  warnings?: string[];
};
export type ToapisRunner = (
  args: string[],
  config: string,
) => Promise<CliResult>;
const require = createRequire(import.meta.url);
export const runToapis: ToapisRunner = (args, config) =>
  new Promise((resolve, reject) => {
    const entry = path.join(
      path.dirname(require.resolve("@petercjl/toapiscli/package.json")),
      "bin/toapiscli.mjs",
    );
    execFile(
      process.execPath,
      [entry, ...args, "--json"],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          TOAPISCLI_CONFIG_DIR: config,
          TOAPISCLI_UPDATE_CHECK: "0",
          TOAPISCLI_AUTO_UPDATE: "0",
        },
        timeout: 16 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        // Never echo argv, stderr or credential contents into IPC/logs.
        try {
          const result = JSON.parse(stdout) as CliResult;
          if (typeof result.ok !== "boolean") throw new Error();
          resolve(result);
        } catch {
          reject(
            new Error(
              error
                ? "ToAPIs 执行中断，保留原请求目录以查询状态。"
                : "ToAPIs 返回格式无效。",
            ),
          );
        }
      },
    );
  });
export function toapisDimensions(size: string, model: string) {
  if (!size || size === "auto") return { resolution: "2K", aspect: "1:1" };
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) throw new Error("ToAPIs 尺寸格式无效。");
  const w = Number(match[1]),
    h = Number(match[2]);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h),
    aspect = `${w / d}:${h / d}`;
  const allowed = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
  if (model === "gemini-nano-banana-2.1")
    allowed.push("1:4", "4:1", "1:8", "8:1");
  if (!allowed.includes(aspect))
    throw new Error("当前 ToAPIs 模型不支持该画幅，请选择标准比例。");
  const pixels = w * h,
    resolution = pixels <= 1_600_000 ? "1K" : pixels <= 5_000_000 ? "2K" : "4K";
  if (resolution === "4K" && model === "doubao-seedream-5-5")
    throw new Error("Seedream 当前授权接口最高支持 2K，请选择 2K 尺寸。");
  return { resolution, aspect };
}

/** Pinned desktop dependency. Config and task evidence live in private app data, never the NAS. */
export class CompanyToapis implements ImageProviderAdapter {
  private imported = new Map<string, Promise<void>>();
  constructor(
    private root: string,
    private resolveGrant: () => {
      namespace: string;
      image: CompanyBootstrap["image"];
    },
    private runner: ToapisRunner = runToapis,
    private beforeGenerate?: () => void,
  ) {}
  private async grant() {
    const { namespace, image } = this.resolveGrant();
    if (!image.enabled || !image.credential)
      throw new Error("当前员工尚未获得生图授权，请联系管理员绑定本人 Key。");
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          image.credential.site,
          image.credential.apiKey,
          image.credential.label ?? null,
        ]),
      )
      .digest("hex");
    const config = path.join(this.root, namespace, "credentials", hash);
    let imported = this.imported.get(config);
    if (!imported) {
      imported = (async () => {
        await mkdir(config, { recursive: true, mode: 0o700 });
        const target = path.join(config, "credentials.json");
        if (await stat(target).catch(() => null)) {
          const current = JSON.parse(await readFile(target, "utf8"));
          if (
            current.schemaVersion !== 1 ||
            current.site !== image.credential!.site ||
            current.apiKey !== image.credential!.apiKey ||
            current.label !== image.credential!.label
          )
            throw new Error("员工凭据缓存不匹配，请重新登录。");
          return;
        }
        const input = path.join(config, "import-" + randomUUID() + ".json");
        await writeFile(input, JSON.stringify(image.credential), {
          flag: "wx",
          mode: 0o600,
        });
        try {
          const result = await this.runner(
            ["auth", "import", "--file", input],
            config,
          );
          if (!result.ok)
            throw new Error(
              "ToAPIs 员工凭据验证失败，请刷新授权或联系管理员。",
            );
        } finally {
          await rm(input, { force: true });
        }
      })().catch((error) => {
        this.imported.delete(config);
        throw error;
      });
      this.imported.set(config, imported);
    }
    await imported;
    return { namespace, image, config };
  }
  async testConnection() {
    await this.grant();
  }
  async generate(input: ProviderGenerateInput): Promise<GenerationResult> {
    this.beforeGenerate?.();
    const grant = await this.grant();
    if (!grant.image.models.includes(input.model))
      throw new Error("该模型不在当前员工的生图授权目录中。");
    if (input.n !== 1) throw new Error("ToAPIs 当前每次生成一张图片。");
    if (input.background === "transparent")
      throw new Error("ToAPIs 当前合同未开放透明背景参数。");
    if (input.outputFormat && input.outputFormat !== "png")
      throw new Error("ToAPIs 当前合同不支持指定此输出格式。");
    if (input.quality && !["auto", "high"].includes(input.quality))
      throw new Error("ToAPIs 当前合同不支持该质量选项。");
    const { resolution, aspect } = toapisDimensions(input.size, input.model);
    const id = input.clientRequestId ?? randomUUID();
    const hash = createHash("sha256").update(id).digest("hex");
    const directory = path.join(this.root, grant.namespace, "tasks", hash),
      output = path.join(directory, "output");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const binding = path.join(directory, "binding.json");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          referenceImages: input.referenceImages.map((r) => ({
            ...r,
            bytes: createHash("sha256").update(r.bytes).digest("hex"),
          })),
        }),
      )
      .digest("hex");
    let result: CliResult;
    if (await stat(binding).catch(() => null)) {
      const saved = JSON.parse(await readFile(binding, "utf8"));
      if (saved.fingerprint !== fingerprint)
        throw new Error("请求标识已用于其他参数，未重复提交。");
      // Any existing intent is recovery-only, including an uncertain submission.
      result = await this.runner(
        ["task", "wait", "--directory", output, "--timeout", "900"],
        grant.config,
      );
    } else {
      await writeFile(binding, JSON.stringify({ fingerprint, requestId: id }), {
        flag: "wx",
        mode: 0o600,
      });
      const prompt = path.join(directory, "prompt.txt");
      await writeFile(prompt, input.prompt, { flag: "wx", mode: 0o600 });
      const args = [
        "image",
        "generate",
        "--model",
        input.model,
        "--prompt-file",
        prompt,
        "--resolution",
        resolution,
        "--aspect",
        aspect,
        "--out-directory",
        output,
        "--submit",
        "--wait",
        "--timeout",
        "900",
      ];
      for (let i = 0; i < input.referenceImages.length; i++) {
        const ref = input.referenceImages[i],
          extension = (
            {
              "image/png": "png",
              "image/jpeg": "jpg",
              "image/webp": "webp",
            } as Record<string, string>
          )[ref.mimeType];
        if (!extension) throw new Error("参考图片需为 PNG、JPG 或 WebP。");
        const file = path.join(directory, `reference-${i}.${extension}`);
        await writeFile(file, ref.bytes, { flag: "wx", mode: 0o600 });
        args.push("--reference", file);
      }
      result = await this.runner(args, grant.config);
    }
    if (
      !result.ok ||
      result.result?.state !== "succeeded" ||
      !result.artifacts?.length
    )
      throw new Error(
        `ToAPIs 任务未成功完成，请保留请求 ${hash} 并查询原任务；未自动重新生成。`,
      );
    const images = [];
    for (const artifact of result.artifacts) {
      const file = path.resolve(artifact.path),
        rel = path.relative(output, file);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
        throw new Error("ToAPIs 返回了无效的素材路径。");
      const bytes = await readFile(file);
      const mimeType = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 255 && bytes[1] === 216
          ? "image/jpeg"
          : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : undefined;
      if (!mimeType) throw new Error("ToAPIs 产物不是受支持的图片。");
      images.push({ bytes, mimeType });
    }
    return { images, warnings: result.warnings };
  }
}
