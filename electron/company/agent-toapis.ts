import { access } from "node:fs/promises";
import path from "node:path";
import { runToapis, type ToapisRunner } from "./toapis.js";

const preparing = new Map<string, Promise<string>>();
/** The pinned package owns Skill/runtime synchronization; account keys stay in CompanyToapis. */
export function ensureAgentToapis(agentDir: string, runner: ToapisRunner = runToapis): Promise<string> {
  const target = path.join(agentDir, "system-skills", "toapiscli");
  let pending = preparing.get(target);
  if (!pending) {
    pending = (async () => {
      const config = path.join(agentDir, "tool-state", "toapiscli");
      const status = await runner(["skill", "status", "--target", target, "--agent", "tuda"], config) as {ok: boolean; current?: boolean; managed?: boolean; edited?: boolean};
      if (!status.ok || !status.current || !status.managed || status.edited) {
        const installed = await runner(["skill", "install", "--target", target, "--agent", "tuda"], config);
        if (!installed.ok) throw new Error("ToAPIs 创作工具安装失败，请重试；现有 Skill 已保留。");
      }
      const policy = await runner(["update", "policy", "--target", target, "--agent", "tuda", "--mode", "off"], config);
      if (!policy.ok) throw new Error("ToAPIs 工具版本策略配置失败。");
      const skill = path.join(target, "SKILL.md");
      await access(skill); await access(path.join(target, ".runtime", "dist", "cli.mjs"));
      return skill;
    })().catch(error => { preparing.delete(target); throw error; });
    preparing.set(target, pending);
  }
  return pending;
}
