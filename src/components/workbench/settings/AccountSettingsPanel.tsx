import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type { EnterpriseStatus } from "@shared/enterprise";
import { AccountAvatar } from "@/components/enterprise/AccountAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUiText } from "@/i18n";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";

export function AccountSettingsPanel({ status }: { status: EnterpriseStatus }) {
  const uiText = useUiText();
  const nicknameId = useId();
  const [nickname, setNickname] = useState(status.accountNickname ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setNickname(status.accountNickname ?? ""), [status.accountNickname]);
  const accountName = status.user?.name || uiText("Tuda 用户");
  const displayName = status.accountNickname || accountName;

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (error) {
      setError(getWorkbenchErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="w-full max-w-xl space-y-5" data-account-settings>
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-4">
      <AccountAvatar name={displayName} url={status.user?.avatarUrl} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{displayName}</p>
        <p className="text-xs text-muted-foreground">{uiText("山海企业账号")}：{accountName}</p>
        <p className="truncate text-xs text-muted-foreground">{status.organizationName}</p>
      </div>
    </div>
    <form className="space-y-2" onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      void run(async () => {
        await getImageWorkbenchApi().updateCompanyProfile(nickname);
        toast.success(uiText("昵称已保存"));
      });
    }}>
      <label htmlFor={nicknameId} className="text-sm font-medium">{uiText("Tuda 昵称")}</label>
      <div className="flex gap-2">
        <Input id={nicknameId} value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={40} placeholder={accountName} />
        <Button type="submit" className="shrink-0" disabled={busy}>{uiText("保存")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{uiText("留空使用账号姓名。")}</p>
    </form>
    {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    <p className="text-xs text-muted-foreground">{uiText("文本模型：")}{status.textModels ?? 0} {uiText("· 生图模型：")}{status.imageModels ?? 0}</p>
    <Button variant="outline" disabled={busy} onClick={() => void run(() => getImageWorkbenchApi().refreshCompanyModels())}>
      {uiText("刷新山海账号与授权")}
    </Button>
  </div>;
}
