import { useUiText } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { Loader2, LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import { useEnterpriseStatus } from "./use-enterprise";
import { AccountAvatar } from "./AccountAvatar";

/** One account control, mounted above every authenticated workspace entrance. */
export function GlobalAccountMenu({ compact = false, floating = false }: { compact?: boolean; floating?: boolean }) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [open, setOpen] = useState(false), [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [expires, setExpires] = useState(0);const polling = useRef(false);
  useEffect(() => {setNickname(status?.accountNickname ?? "");}, [status?.accountNickname, open]);
  useEffect(() => {
    if (!expires) return;
    const timer = window.setInterval(() => {
      if (Date.now() > expires) {setExpires(0);setBusy(false);setError(uiText("刷新资料已超时，请重试。"));return;}
      if (polling.current) return;polling.current = true;
      void getImageWorkbenchApi().pollEnterpriseLogin().then(result => {
        if (result.status === "authorized") {setExpires(0);setBusy(false);toast.success(uiText("钉钉资料已更新"));}
      }).catch(value => {setError(getWorkbenchErrorMessage(value));setBusy(false);setExpires(0);}).finally(() => {polling.current = false;});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [expires, uiText]);
  if (!status?.authenticated) return null;
  const guest = status.accountKind === "password";
  const dingTalkName = status.user?.name || uiText("Tuda 用户"), displayName = status.accountNickname || dingTalkName;
  const run = async (work: () => Promise<unknown>) => {setBusy(true);setError("");try {await work();}catch(value){setError(getWorkbenchErrorMessage(value));}finally{setBusy(false);}};
  return <>
    <button type="button" aria-label={uiText("账号设置：{{ui:0}}", [displayName])} title={displayName} data-global-account
      onClick={() => setOpen(true)} className={`tuda-global-account-trigger flex items-center gap-2 rounded-lg p-2 text-left transition hover:bg-accent [-webkit-app-region:no-drag] ${floating ? "fixed bottom-2 left-2 z-[49] bg-background/90 shadow-sm ring-1 ring-border/60" : "w-full shrink-0"} ${compact ? "justify-center" : ""}`}>
      <AccountAvatar name={displayName} url={status.user?.avatarUrl} />
      {!compact && <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{displayName}</span><span className="block truncate text-xs text-muted-foreground">{status.organizationName}</span></span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-[420px]" data-account-settings>
      <DialogHeader><DialogTitle>{uiText("账号设置")}</DialogTitle><DialogDescription>{uiText("管理你的 Tuda 昵称与登录账号。")}</DialogDescription></DialogHeader>
      <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-3"><AccountAvatar name={displayName} url={status.user?.avatarUrl} /><div className="min-w-0"><p className="truncate text-sm font-medium">{displayName}</p><p className="text-xs text-muted-foreground">{guest ? uiText("账号") : uiText("钉钉")}：{dingTalkName}</p><p className="truncate text-xs text-muted-foreground">{status.organizationName}</p></div></div>
      <div className="space-y-2"><label htmlFor="tuda-account-nickname" className="text-sm font-medium">{uiText("Tuda 昵称")}</label><div className="flex gap-2"><Input id="tuda-account-nickname" aria-label={uiText("Tuda 昵称")} value={nickname} onChange={event => setNickname(event.target.value)} maxLength={40} placeholder={dingTalkName} /><Button className="shrink-0" disabled={busy} onClick={() => void run(async () => {await getImageWorkbenchApi().updateCompanyProfile(nickname);toast.success(uiText("昵称已保存"));})}>{uiText("保存")}</Button></div><p className="text-xs text-muted-foreground">{uiText("留空使用钉钉姓名。")}</p></div>
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">{uiText("文本模型：")}{status.textModels ?? 0} {uiText("· 生图模型：")}{status.imageModels ?? 0}</p>
      <Button variant="outline" disabled={busy} onClick={() => void run(() => getImageWorkbenchApi().refreshCompanyModels())}>{uiText("刷新模型授权")}</Button>
      <div className="flex flex-wrap gap-2">{!guest && <Button variant="outline" disabled={busy} onClick={() => {setBusy(true);setError("");void getImageWorkbenchApi().beginEnterpriseLogin({refreshProfile: true}).then(result => setExpires(Date.parse(result.expiresAt))).catch(value => {setError(getWorkbenchErrorMessage(value));setBusy(false);});}}>{expires ? <Loader2 className="mr-1 size-4 animate-spin" /> : <RefreshCw className="mr-1 size-4" />}{expires ? uiText("等待钉钉授权") : uiText("更新钉钉资料")}</Button>}<Button variant="outline" disabled={busy} onClick={() => void run(() => getImageWorkbenchApi().enterpriseLogout())}><LogOut className="mr-1 size-4" />{uiText("退出登录")}</Button></div>
    </DialogContent></Dialog>
  </>;
}
