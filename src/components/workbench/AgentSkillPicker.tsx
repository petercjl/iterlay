import { useUiText } from "@/i18n";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { BookOpen, Check, Star } from "lucide-react";
import type { AgentSkillLibrary, AgentSkillLibraryMutation, PiAgentResourceEntry, PiAgentResourceInventory } from "@shared/types";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentSkillBoard } from "./AgentSkillBoard";

export function AgentSkillPicker({ value, onChange, disabled }: {
  value?: string; onChange: (path: string | undefined) => void; disabled?: boolean;
}): React.ReactElement {
  const uiText = useUiText();
  const trigger = useRef<HTMLButtonElement>(null);
  const [inventory, setInventory] = useState<PiAgentResourceInventory | null>(null);
  const [library, setLibrary] = useState<AgentSkillLibrary>({ version: 1, folders: [], assignments: {}, favorites: [] });
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [bounds, setBounds] = useState<CSSProperties>({ left: 0, top: 0, width: "100vw", height: "100vh", transform: "none" });
  function measure(): void {
    const host = trigger.current?.closest<HTMLElement>("[data-agent-skill-host]");
    const rect = host?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(0, Math.min(rect.left, window.innerWidth - 320));
    const top = rect.height < 320 ? 48 : Math.max(0, rect.top);
    setBounds({ left, top, width: Math.min(window.innerWidth - left, Math.max(320, rect.width)), height: rect.height < 320 ? window.innerHeight - top : Math.min(rect.height, window.innerHeight - top), transform: "none" });
  }
  useLayoutEffect(() => {
    if (!open) return;
    measure(); const host = trigger.current?.closest<HTMLElement>("[data-agent-skill-host]");
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (host) observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [open]);
  async function refresh(): Promise<void> {
    setLoading(true); setError("");
    try {
      const api = getImageWorkbenchApi();
      const [result, organization] = await Promise.all([api.getPiAgentResources(), api.getAgentSkillLibrary()]);
      setInventory(result); setLibrary(organization);
      if (value && !result.skills.some((skill) => skill.path === value)) onChange(undefined);
    } catch (e) { setError(getWorkbenchErrorMessage(e, uiText("无法读取 Skill，请重试。"))); }
    finally { setLoading(false); }
  }
  async function mutate(operation: AgentSkillLibraryMutation): Promise<AgentSkillLibrary> {
    const result = await getImageWorkbenchApi().updateAgentSkillLibrary(operation); setLibrary(result); return result;
  }
  async function remove(skillPath: string): Promise<void> {
    setLoading(true); setError("");
    try {
      const removed = await getImageWorkbenchApi().deletePiAgentSkill(skillPath);
      if (removed && value === skillPath) onChange(undefined);
      await refresh();
    } catch (e) { setError(getWorkbenchErrorMessage(e, uiText("删除失败，请重试。"))); }
    finally { setLoading(false); }
  }
  const selected = inventory?.skills.find((skill) => skill.path === value);
  const userSkills = inventory?.skills.filter((skill) => skill.skillCategory !== "system") ?? [];
  const systemSkills = inventory?.skills.filter((skill) => skill.skillCategory === "system") ?? [];
  const favorites = inventory?.skills.filter((skill) => library.favorites.includes(skill.path)) ?? [];
  function skillItem(skill: PiAgentResourceEntry): React.ReactElement {
    return <DropdownMenuItem key={skill.path} onSelect={() => onChange(skill.path)}>
      <span className="min-w-0 flex-1"><span className="block truncate">{skill.name}</span><span className="block truncate text-xs text-muted-foreground">{skill.description}</span></span>
      {value === skill.path && <Check size={14} />}
    </DropdownMenuItem>;
  }
  return <>
    <DropdownMenu onOpenChange={(next) => { if (next) void refresh(); }}>
      <DropdownMenuTrigger asChild><button ref={trigger} type="button" disabled={disabled} aria-label={uiText("选择 Skill")}
        className="inline-flex h-8 max-w-44 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent">
        <BookOpen size={14} /><span className="truncate">{selected?.name ?? (value ? uiText("已选 Skill") : "Skill")}</span>
      </button></DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="max-h-96 w-72 overflow-y-auto">
        <DropdownMenuLabel>{uiText("指定本轮 Skill")}</DropdownMenuLabel>
        {value && <DropdownMenuItem onSelect={() => onChange(undefined)}>{uiText("取消指定")}</DropdownMenuItem>}
        {favorites.length > 0 && <><DropdownMenuLabel className="flex items-center gap-1"><Star size={12} />{uiText("收藏")}</DropdownMenuLabel>{favorites.map(skillItem)}<DropdownMenuSeparator /></>}
        <DropdownMenuLabel>{uiText("用户 Skill")}</DropdownMenuLabel>
        {userSkills.map(skillItem)}
        {!loading && !userSkills.length && <p className="px-2 py-2 text-xs text-muted-foreground">{uiText("暂无用户 Skill，可在对话中创建。")}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuSub><DropdownMenuSubTrigger>{uiText("系统 Skill")}（{systemSkills.length}）</DropdownMenuSubTrigger><DropdownMenuSubContent className="max-h-80 w-80 overflow-y-auto">{systemSkills.map(skillItem)}</DropdownMenuSubContent></DropdownMenuSub>
        {loading && <DropdownMenuLabel>{uiText("读取中…")}</DropdownMenuLabel>}
        {error && <p role="alert" className="p-2 text-xs text-destructive">{error}</p>}
        <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { measure(); setOpen(true); void refresh(); }}>{uiText("Skill 看板")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent hideClose aria-describedby={undefined} overlayClassName="bg-transparent" style={bounds} className="flex max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 shadow-xl">
        <DialogTitle className="sr-only">{uiText("Skill 看板")}</DialogTitle>
        <AgentSkillBoard inventory={inventory} library={library} loading={loading} error={error} disabled={disabled} onRefresh={refresh} onMutation={mutate} onUse={(skill) => { onChange(skill); setOpen(false); }} onDelete={remove} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  </>;
}
