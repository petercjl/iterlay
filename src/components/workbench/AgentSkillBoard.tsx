import { useMemo, useState } from "react";
import { BookOpen, Folder, FolderPlus, Layers, Pencil, RefreshCw, Search, Star, Trash2, X } from "lucide-react";
import type { AgentSkillLibrary, AgentSkillLibraryMutation, PiAgentResourceEntry, PiAgentResourceInventory } from "@shared/types";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import { useUiText } from "@/i18n";

export function skillFolderLabel(library: AgentSkillLibrary, id?: string): string {
  const labels: string[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id); const folder = library.folders.find((item) => item.id === id);
    if (!folder) break;
    labels.unshift(folder.name); id = folder.parentId ?? undefined;
  }
  return labels.join(" / ");
}

export function filterSkillLibrary(skills: PiAgentResourceEntry[], library: AgentSkillLibrary, section: string, query: string): PiAgentResourceEntry[] {
  const search = query.trim().toLocaleLowerCase();
  return skills.filter((skill) => {
    if (section === "favorites" ? !library.favorites.includes(skill.path)
      : section === "system" ? skill.skillCategory !== "system"
      : section === "users" ? skill.skillCategory === "system"
      : skill.skillCategory === "system" || library.assignments[skill.path] !== section) return false;
    return !search || `${skill.name}\n${skill.description}\n${skillFolderLabel(library, library.assignments[skill.path])}`.toLocaleLowerCase().includes(search);
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function AgentSkillBoard({ inventory, library, loading, error, disabled, onRefresh, onMutation, onUse, onDelete, onClose }: {
  inventory: PiAgentResourceInventory | null; library: AgentSkillLibrary; loading: boolean; error: string; disabled?: boolean;
  onRefresh: () => Promise<void>; onMutation: (operation: AgentSkillLibraryMutation) => Promise<AgentSkillLibrary>;
  onUse: (path: string) => void; onDelete: (path: string) => Promise<void>; onClose: () => void;
}): React.ReactElement {
  const uiText = useUiText();
  const [section, setSection] = useState("users"), [query, setQuery] = useState("");
  const [folderForm, setFolderForm] = useState(false), [folderName, setFolderName] = useState("");
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [saving, setSaving] = useState(false), [localError, setLocalError] = useState("");
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const skills = inventory?.skills ?? [], busy = saving || loading;
  const visible = useMemo(() => filterSkillLibrary(skills, library, section, query), [skills, library, section, query]);
  const folder = library.folders.find((item) => item.id === section);
  const title = section === "favorites" ? uiText("收藏") : section === "system" ? uiText("系统 Skill") : folder ? skillFolderLabel(library, folder.id) : uiText("全部用户 Skill");
  async function mutate(operation: AgentSkillLibraryMutation): Promise<AgentSkillLibrary | undefined> {
    setSaving(true); setLocalError("");
    try { return await onMutation(operation); }
    catch (e) { setLocalError(getWorkbenchErrorMessage(e, uiText("保存分类失败，请重试。"))); }
    finally { setSaving(false); }
  }
  const sortedFolders = [...library.folders].sort((a, b) => skillFolderLabel(library, a.id).localeCompare(skillFolderLabel(library, b.id)));
  const nav = (id: string, label: string, icon: React.ReactNode, count: number) => <button key={id} type="button" onClick={() => { setSection(id); setPreview(null); }} aria-current={section === id ? "page" : undefined}
    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${section === id ? "bg-blue-500/10 font-medium text-blue-500" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
    {icon}<span className="min-w-0 flex-1 truncate">{label}</span><span className="text-xs opacity-70">{count}</span></button>;
  return <>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><BookOpen size={20} />{uiText("Skill 看板")}</h2>
      <button type="button" onClick={onClose} aria-label={uiText("关闭 Skill 看板")} className="rounded-md p-2 text-muted-foreground hover:bg-accent"><X size={18} /></button>
    </header>
    <div className="flex min-h-0 flex-1">
      <aside aria-label={uiText("Skill 分类导航")} className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-muted/20 p-3 lg:w-52">
        {nav("favorites", uiText("收藏"), <Star size={16} />, skills.filter((skill) => library.favorites.includes(skill.path)).length)}
        {nav("users", uiText("全部用户 Skill"), <BookOpen size={16} />, skills.filter((skill) => skill.skillCategory !== "system").length)}
        <div className="mb-1 mt-5 flex items-center justify-between px-2 text-xs text-muted-foreground"><span>{uiText("文件夹")}</span><button type="button" disabled={busy} aria-label={uiText("新建 Skill 文件夹")} onClick={() => { setEditingFolder(null); setFolderName(""); setFolderForm(true); }} className="rounded p-1 hover:bg-accent"><FolderPlus size={15} /></button></div>
        {sortedFolders.map((item) => <div key={item.id} className={`group flex items-center rounded-lg ${section === item.id ? "bg-blue-500/10" : "hover:bg-accent"}`}>
          <button type="button" title={skillFolderLabel(library, item.id)} onClick={() => { setSection(item.id); setPreview(null); }} className={`flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 text-sm ${section === item.id ? "text-blue-500" : "text-muted-foreground"}`} style={{ paddingLeft: 8 + Math.min(4, skillFolderLabel(library, item.id).split(" / ").length - 1) * 10 }}><Folder size={15} className="shrink-0" /><span className="truncate">{item.name}</span></button>
          <button type="button" disabled={busy} aria-label={uiText("重命名文件夹") + " " + item.name} onClick={() => { setEditingFolder(item.id); setFolderName(item.name); setFolderForm(true); }} className="p-1 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100"><Pencil size={12} /></button>
          <button type="button" disabled={busy} aria-label={uiText("删除分类") + " " + item.name} onClick={async () => { const next = await mutate({ type: "deleteFolder", id: item.id }); if (next && library.folders.some((entry) => entry.id === section) && !next.folders.some((entry) => entry.id === section)) setSection("users"); }} className="p-1 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"><Trash2 size={12} /></button>
        </div>)}
        {!library.folders.length && <p className="px-2 py-2 text-xs text-muted-foreground">{uiText("新建文件夹整理用户 Skill")}</p>}
        <div className="mt-4 border-t border-border pt-3">{nav("system", uiText("系统 Skill"), <Layers size={16} />, skills.filter((skill) => skill.skillCategory === "system").length)}</div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{title}</h3><span className="text-xs text-muted-foreground">{visible.length} {uiText("个 Skill")}</span></div>
          <label className="flex h-9 w-full max-w-sm items-center gap-2 rounded-lg border border-input bg-background px-3"><Search size={15} className="shrink-0 text-muted-foreground" /><input value={query} onChange={(e) => setQuery(e.target.value)} aria-label={uiText("搜索 Skill")} placeholder={uiText("搜索名称、描述或分类…")} className="w-full min-w-0 bg-transparent text-sm outline-none" />{query && <button type="button" aria-label={uiText("清空搜索")} onClick={() => setQuery("")}><X size={13} /></button>}</label>
          <button type="button" disabled={busy} onClick={() => void onRefresh()} aria-label={uiText("刷新 Skill")} className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-accent"><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></button>
        </div>
        {folderForm && <form className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-5 py-3" onSubmit={async (event) => {
          event.preventDefault(); const next = await mutate(editingFolder ? { type: "renameFolder", id: editingFolder, name: folderName } : { type: "createFolder", name: folderName, parentId: folder?.id ?? null });
          if (next) { setFolderForm(false); if (!editingFolder) setSection(next.folders.at(-1)!.id); }
        }}><span className="text-xs text-muted-foreground">{editingFolder ? uiText("重命名文件夹") : folder ? `${uiText("新建子文件夹")} · ${folder.name}` : uiText("新建文件夹")}</span><input autoFocus value={folderName} onChange={(e) => setFolderName(e.target.value)} aria-label={uiText("Skill 文件夹名称")} maxLength={80} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-blue-500" /><button type="submit" disabled={busy || !folderName.trim()} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{uiText("保存")}</button><button type="button" onClick={() => setFolderForm(false)} className="px-2 text-xs text-muted-foreground">{uiText("取消")}</button></form>}
        {(error || localError) && <p role="alert" className="px-5 py-2 text-sm text-destructive">{error || localError}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!loading && !visible.length && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><BookOpen size={30} className="opacity-40" /><p>{query ? uiText("没有匹配的 Skill") : section === "favorites" ? uiText("点击 Skill 上的星标，将常用 Skill 加入收藏。") : folder ? uiText("此文件夹暂无 Skill，可在 Skill 卡片中选择分类。") : section === "system" ? uiText("暂无系统 Skill") : uiText("暂无用户 Skill，可以回到对话中创建。")}</p></div>}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
            {visible.map((skill) => <article key={skill.path} className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-blue-500/40">
              <div className="flex items-start justify-between gap-2"><h4 className="min-w-0 break-words text-sm font-semibold">{skill.name}</h4><button type="button" disabled={busy} aria-label={(library.favorites.includes(skill.path) ? uiText("取消收藏") : uiText("收藏 Skill")) + " " + skill.name} aria-pressed={library.favorites.includes(skill.path)} onClick={() => void mutate({ type: "setFavorite", skillPath: skill.path, favorite: !library.favorites.includes(skill.path) })} className="shrink-0 p-0.5 text-muted-foreground hover:text-amber-500"><Star size={17} className={library.favorites.includes(skill.path) ? "fill-amber-400 text-amber-500" : ""} /></button></div>
              <p className="mb-4 mt-2 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
              <div className="mt-auto space-y-3">
                {skill.skillCategory !== "system" ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><Folder size={13} /><select aria-label={uiText("分类文件夹") + " " + skill.name} disabled={busy} value={library.assignments[skill.path] ?? ""} onChange={(e) => void mutate({ type: "setFolder", skillPath: skill.path, folderId: e.target.value || null })} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1"><option value="">{uiText("未分类")}</option>{sortedFolders.map((item) => <option key={item.id} value={item.id}>{skillFolderLabel(library, item.id)}</option>)}</select></label> : <span className="text-xs text-muted-foreground">{uiText("系统 Skill")}</span>}
                <div className="flex items-center gap-3 text-xs"><button type="button" disabled={disabled || busy} onClick={() => onUse(skill.path)} className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50">{uiText("使用")}</button><button type="button" onClick={async () => { try { const detail = await getImageWorkbenchApi().getPiAgentResourceDetail(skill.path); setPreview({ name: skill.name, content: detail.content }); } catch (e) { setLocalError(getWorkbenchErrorMessage(e, uiText("读取失败"))); } }} className="text-muted-foreground hover:text-foreground">{uiText("查看内容")}</button>{skill.canDelete && <button type="button" disabled={disabled || busy} aria-label={uiText("删除 Skill") + " " + skill.name} onClick={() => void onDelete(skill.path)} className="ml-auto text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>}</div>
              </div>
            </article>)}
          </div>
        </div>
        {preview && <section aria-label={uiText("Skill 内容预览")} className="absolute inset-0 z-10 flex flex-col border-l border-border bg-background shadow-xl"><header className="flex items-center justify-between border-b border-border px-5 py-3"><h3 className="truncate text-sm font-medium">{preview.name}</h3><button type="button" aria-label={uiText("关闭内容预览")} onClick={() => setPreview(null)} className="p-2 text-muted-foreground"><X size={17} /></button></header><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 text-xs leading-relaxed">{preview.content}</pre></section>}
      </main>
    </div>
  </>;
}
