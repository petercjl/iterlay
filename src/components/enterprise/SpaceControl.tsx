import { useUiText } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Building2, ChevronDown, Cloud, CloudOff, Loader2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import type { EnterpriseMember, EnterpriseRole } from "@shared/enterprise";
import type { BoardSummary } from "@shared/types";
import { MemberProviders } from "./MemberProviders";
import { useEnterpriseStatus } from "./use-enterprise";

export function SpaceControl({ compact = false }: { compact?: boolean }) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [open, setOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loginExpires, setLoginExpires] = useState("");
  const [members, setMembers] = useState<Array<EnterpriseMember & { active: boolean }> | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [copyId, setCopyId] = useState("");
  const polling = useRef(false);
  useEffect(() => { if (status?.serverUrl) setServerUrl(status.serverUrl); }, [status?.serverUrl]);
  useEffect(() => { if (status?.activeSpace === "enterprise" && !status.authenticated) setOpen(true); }, [status?.activeSpace, status?.authenticated]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await work(); } catch (value) { setError(getWorkbenchErrorMessage(value, uiText("操作失败，请重试。"))); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!loginExpires) return;
    const timer = window.setInterval(() => {
      if (polling.current) return;
      if (Date.parse(loginExpires) < Date.now()) { setLoginExpires(""); setError(uiText("登录请求已过期，请重新发起。")); return; }
      polling.current = true;
      void getImageWorkbenchApi().pollEnterpriseLogin().then(result => { if (result.status === "authorized") { setLoginExpires(""); setOpen(false); } })
        .catch(value => { setError(getWorkbenchErrorMessage(value)); setLoginExpires(""); })
        .finally(() => { polling.current = false; });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loginExpires, uiText]);
  if (!status) return null;
  const company = status.activeSpace === "enterprise";
  return <>
    <button type="button" aria-label={uiText("切换个人与企业空间")} data-space={status.activeSpace} onClick={() => setOpen(true)}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/70 text-xs [-webkit-app-region:no-drag] ${compact ? "px-2 py-1.5" : "mx-4 mb-3 px-3 py-2.5"}`}>
      {company ? <Building2 className="h-4 w-4 shrink-0 text-blue-500" /> : <UserRound className="h-4 w-4 shrink-0" />}
      <span className="truncate">{company ? status.organizationName || uiText("企业空间") : uiText("个人空间")}</span>
      {company && (status.connected ? <Cloud aria-label={uiText("企业已连接")} className="h-3.5 w-3.5 text-emerald-500" /> : <CloudOff aria-label={uiText("企业未连接")} className="h-3.5 w-3.5 text-amber-500" />)}
      {company && status.peers.length > 0 && <span>{status.peers.length + 1} {uiText("人")}</span>}
      <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-lg" data-enterprise-dialog>
        <DialogHeader><DialogTitle>{uiText("个人与企业空间")}</DialogTitle><DialogDescription>{uiText("个人内容保存在本机，企业内容由公司 NAS 管理。")}</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Button variant={company ? "outline" : "default"} disabled={busy || !company} onClick={() => void run(() => getImageWorkbenchApi().selectSpace("personal"))}><UserRound className="mr-2 h-4 w-4" />{uiText("个人空间")}</Button>
          <Button variant={company ? "default" : "outline"} disabled={busy || company || !status.authenticated} onClick={() => void run(() => getImageWorkbenchApi().selectSpace("enterprise"))}><Building2 className="mr-2 h-4 w-4" />{uiText("企业空间")}</Button>
        </div>
        <div className="space-y-2 border-t pt-4">
          <label htmlFor="enterprise-server-url" className="text-sm font-medium">{uiText("企业服务地址")}</label>
          <div className="flex gap-2"><Input id="enterprise-server-url" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://tuda.example.com" autoComplete="off" />
            <Button variant="outline" disabled={busy || !serverUrl.trim()} onClick={() => void run(() => getImageWorkbenchApi().configureEnterprise(serverUrl.trim()))}>{uiText("连接")}</Button></div>
        </div>
        {status.authenticated ? <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <p className="font-medium">{status.organizationName}</p><p className="mt-1 text-muted-foreground">{status.user?.name} · {status.user?.role === "admin" ? uiText("管理员") : status.user?.role === "editor" ? uiText("可编辑") : uiText("只读")}</p>
          <p className="mt-2 text-xs">{status.pendingWrites ? `${status.pendingWrites} 项修改等待服务端保存` : company ? status.connected ? uiText("实时协同已连接") : uiText("连接中断，未确认的修改将保留在本机") : uiText("切换企业空间后可查看团队画板")}</p>
        </div> : <div className="space-y-3 rounded-lg bg-muted/50 p-3 text-sm">
          <p>{uiText("使用公司钉钉账号登录。验证成功后默认进入企业空间。")}</p>
          <Button className="w-full" disabled={busy || !status.configured || Boolean(loginExpires)} onClick={() => void run(async () => {
            const result = await getImageWorkbenchApi().beginEnterpriseLogin(); setLoginExpires(result.expiresAt);
          })}>{loginExpires ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{uiText("等待浏览器完成钉钉登录")}</> : uiText("使用钉钉登录企业空间")}</Button>
          {loginExpires && <Button variant="ghost" size="sm" onClick={() => setLoginExpires("")}>{uiText("重新发起登录")}</Button>}
        </div>}
        {(error || status.error) && <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error || status.error}</p>}
        {status.authenticated && <>
          <p className="text-xs text-muted-foreground">{uiText("管理员可在成员设置中分配模型服务。查看成员可以浏览画板；编辑成员可修改内容和提交任务。")}</p>
          {status.pendingWrites > 0 && <Button disabled={busy} variant="outline" onClick={() => void run(() => getImageWorkbenchApi().retryEnterpriseSync())}>{uiText("重试同步")}</Button>}
          {status.activeSpace === "personal" && <details className="rounded-lg border p-3" onToggle={event => {
            if (event.currentTarget.open) void getImageWorkbenchApi().listBoards().then(setBoards).catch(() => undefined);
          }}><summary className="cursor-pointer text-sm">{uiText("复制个人画板到企业空间")}</summary><div className="mt-3 flex gap-2">
            <select aria-label={uiText("选择要复制的个人画板")} className="min-w-0 flex-1 rounded border bg-background px-2 text-sm" value={copyId} onChange={event => setCopyId(event.target.value)}><option value="">{uiText("选择画板")}</option>{boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}</select>
            <Button size="sm" disabled={!copyId || busy} onClick={() => void run(async () => { const value = await getImageWorkbenchApi().copyBoardToEnterprise(copyId); toast.success(`已复制「${value.name}」到企业空间`); })}>{uiText("复制")}</Button>
          </div><p className="mt-2 text-xs text-muted-foreground">{uiText("保留本机原画板，复制画板及关联素材。")}</p></details>}
          {status.user?.role === "admin" && <details className="rounded-lg border p-3" onToggle={event => { if (event.currentTarget.open) void run(async () => setMembers(await getImageWorkbenchApi().enterpriseMembers())); }}>
            <summary className="cursor-pointer text-sm">{uiText("企业成员与权限")}</summary>
            <div className="mt-3 space-y-3">{members?.map(member => <div key={member.id} className="space-y-1 border-b pb-2 last:border-0"><div className="flex items-center gap-2 text-sm"><span className="min-w-0 flex-1 truncate">{member.name}</span>
              <select aria-label={`${member.name}的权限`} className="rounded border bg-background px-2 py-1" value={member.role} disabled={busy} onChange={event => void run(async () => { await getImageWorkbenchApi().updateEnterpriseMember({ id: member.id, role: event.target.value as EnterpriseRole, active: member.active }); setMembers(await getImageWorkbenchApi().enterpriseMembers()); })}><option value="viewer">{uiText("只读")}</option><option value="editor">{uiText("编辑")}</option><option value="admin">{uiText("管理")}</option></select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await getImageWorkbenchApi().updateEnterpriseMember({ id: member.id, role: member.role, active: !member.active }); setMembers(await getImageWorkbenchApi().enterpriseMembers()); })}>{member.active ? uiText("停用") : uiText("启用")}</Button>
            </div><MemberProviders member={member} run={run} busy={busy} /></div>) ?? <p className="text-xs text-muted-foreground">{uiText("正在读取成员…")}</p>}</div>
          </details>}
          <Button disabled={busy} variant="ghost" onClick={() => void run(() => getImageWorkbenchApi().enterpriseLogout())}>{uiText("退出企业登录")}</Button>
        </>}
        {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{uiText("正在处理…")}</div>}
      </DialogContent>
    </Dialog>
  </>;
}
