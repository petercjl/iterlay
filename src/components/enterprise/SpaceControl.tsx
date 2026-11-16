import { useUiText } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Building2, Check, ChevronDown, Cloud, CloudOff, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import { useEnterpriseStatus } from "./use-enterprise";

/** Storage selection only. GlobalAccountMenu owns identity and account settings. */
export function SpaceControl({ compact = false }: { compact?: boolean }) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [open, setOpen] = useState(false), [nasUrl, setNasUrl] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const warned = useRef(false);
  useEffect(() => {if (status?.storageUrl) setNasUrl(status.storageUrl);}, [status?.storageUrl]);
  useEffect(() => {
    const unavailable = status?.authenticated && (status.storageError || (status.activeSpace === "enterprise" && !status.connected));
    if (!unavailable) {warned.current = false;return;}
    const timer = window.setTimeout(() => {if (!warned.current) {toast.warning(uiText("NAS 连接失败，请先使用本地空间完成工作。"));warned.current = true;}}, 2000);
    return () => window.clearTimeout(timer);
  }, [status?.authenticated, status?.activeSpace, status?.connected, status?.storageError, uiText]);
  if (!status?.authenticated) return null;
  if (status.accountKind === "password") return <div className="px-3 py-2 text-sm text-muted-foreground">{uiText("本地空间")}</div>;
  const company = status.activeSpace === "enterprise", unavailable = !!status.storageError || (company && !status.connected);
  const run = async (work: () => Promise<unknown>) => {setBusy(true);setError("");try {await work();}catch(value){setError(getWorkbenchErrorMessage(value));}finally{setBusy(false);}};
  const select = (enterprise: boolean) => void run(async () => {
    if (company === enterprise && (!enterprise || status.connected)) {setOpen(false);return;}
    const result = await getImageWorkbenchApi().selectSpace(enterprise ? "enterprise" : "personal");
    if (enterprise && result.activeSpace !== "enterprise") setError(uiText("NAS 连接失败，请先使用本地空间完成工作。"));else setOpen(false);
  });
  return <>
    <button type="button" aria-label={uiText("切换本地与企业空间")} data-space={status.activeSpace} onClick={() => setOpen(true)}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/70 text-xs [-webkit-app-region:no-drag] ${compact ? "px-2 py-1.5" : "mx-4 mb-3 px-3 py-2.5"}`}>
      {company ? <Building2 className="size-4 shrink-0 text-blue-500" /> : <FolderOpen className="size-4 shrink-0" />}
      <span className="truncate">{company ? uiText("企业空间") : uiText("本地空间")}</span>
      {company && (status.connected ? <Cloud aria-label={uiText("NAS 已连接")} className="size-3.5 text-emerald-500" /> : <CloudOff aria-label={uiText("NAS 未连接")} className="size-3.5 text-amber-500" />)}
      <ChevronDown className="ml-auto size-3 shrink-0" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-[460px]" data-enterprise-dialog>
      <DialogHeader><DialogTitle>{uiText("工作空间")}</DialogTitle><DialogDescription>{uiText("选择本地工作或团队共享空间。")}</DialogDescription></DialogHeader>
      <div role="radiogroup" aria-label={uiText("工作空间")} className="grid grid-cols-2 gap-3">
        {[true, false].map(enterprise => {const selected = company === enterprise, Icon = enterprise ? Building2 : FolderOpen;
          return <button key={String(enterprise)} type="button" role="radio" aria-checked={selected} disabled={busy} onClick={() => select(enterprise)}
            className={`relative flex min-h-32 flex-col items-start rounded-xl border p-4 text-left disabled:opacity-60 ${selected ? "border-blue-500 bg-blue-500/5 ring-1 ring-blue-500" : "border-border hover:bg-muted/50"}`}>
            <div className="mb-4 flex w-full items-center justify-between"><Icon className="size-5 text-blue-500" />{selected && <Check className="size-4 text-blue-500" />}</div>
            <span className="text-sm font-medium">{enterprise ? uiText("企业空间") : uiText("本地空间")}{enterprise && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{uiText("默认")}</span>}</span>
            <span className="mt-1 text-xs text-muted-foreground">{enterprise ? uiText("NAS 存储，团队共享与协作") : uiText("保存在这台电脑，独立工作")}</span>
          </button>;
        })}
      </div>
      {unavailable && <p role="status" className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">{uiText("NAS 连接失败，请先使用本地空间完成工作。")}</p>}
      {status.nasPendingWrites ? <p className="text-xs text-amber-600">{uiText("NAS 待同步修改已保留，连接恢复后继续同步。")}</p> : null}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <details className="group border-t pt-3" data-company-advanced><summary className="flex cursor-pointer items-center justify-between text-xs text-muted-foreground">{uiText("高级设置")}<ChevronDown className="size-3" /></summary>
        <div className="mt-4 space-y-2"><label className="text-xs text-muted-foreground" htmlFor="company-nas-url">{uiText("NAS 服务地址")}</label><div className="flex gap-2"><Input id="company-nas-url" value={nasUrl} onChange={event => setNasUrl(event.target.value)} /><Button variant="outline" disabled={busy || !nasUrl.trim()} onClick={() => void run(() => getImageWorkbenchApi().chooseCompanyNas(nasUrl.trim()))}>{uiText("连接")}</Button></div></div>
      </details>
    </DialogContent></Dialog>
  </>;
}
