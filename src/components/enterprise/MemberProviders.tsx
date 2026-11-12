import { useUiText } from "@/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getImageWorkbenchApi } from "@/lib/image-workbench-api";
import type { EnterpriseMember, EnterpriseProviderMetadata } from "@shared/enterprise";

export function MemberProviders({ member, run, busy }: {
  member: EnterpriseMember; run: (work: () => Promise<unknown>) => Promise<void>; busy: boolean;
}) {
  const uiText = useUiText();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"image" | "text">("image");
  const [accounts, setAccounts] = useState<Record<"image" | "text", EnterpriseProviderMetadata>>();
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const load = (value: EnterpriseProviderMetadata) => { setBaseUrl(value.baseUrl); setModel(value.model); setApiKey(""); };
  return <div className="space-y-2">
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
      if (open) { setOpen(false); setApiKey(""); return; }
      const values = await getImageWorkbenchApi().enterpriseProviderAccounts(member.id);
      setAccounts(values); load(values[kind]); setOpen(true);
    })}>{uiText("为 {{ui:0}} 配置模型服务", [member.name])}</Button>
    {open && <div className="space-y-2 rounded-md bg-muted/50 p-3">
      <select aria-label={`${member.name}的模型服务类型`} value={kind} onChange={event => { const next = event.target.value as "image" | "text"; setKind(next); if (accounts) load(accounts[next]); }} className="w-full rounded border bg-background p-2 text-sm"><option value="image">{uiText("图片生成")}</option><option value="text">{uiText("对话模型")}</option></select>
      <Input aria-label={uiText("模型服务地址")} placeholder="https://api.example.com/v1" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} autoComplete="off" />
      <Input aria-label={uiText("模型名称")} placeholder={uiText("模型名称")} value={model} onChange={event => setModel(event.target.value)} autoComplete="off" />
      <Input aria-label={uiText("模型 API Key")} type="password" placeholder={accounts?.[kind].hasKey ? uiText("已配置密钥，留空保留") : uiText("输入 API Key")} value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" />
      <p className="text-xs text-muted-foreground">{uiText("仅管理员配置。密钥加密保存在 NAS，由服务端代员工调用。")}</p>
      <div className="flex gap-2"><Button size="sm" disabled={busy || !baseUrl || !model} onClick={() => void run(async () => {
        await getImageWorkbenchApi().assignEnterpriseProvider({ userId: member.id, kind, enabled: true, baseUrl, model, apiKey: apiKey || undefined });
        setApiKey(""); const values = await getImageWorkbenchApi().enterpriseProviderAccounts(member.id); setAccounts(values); load(values[kind]);
      })}>{uiText("保存分配")}</Button>
      <Button size="sm" variant="outline" disabled={busy || !accounts?.[kind].enabled} onClick={() => void run(async () => {
        await getImageWorkbenchApi().assignEnterpriseProvider({ userId: member.id, kind, enabled: false });
        const values = await getImageWorkbenchApi().enterpriseProviderAccounts(member.id); setAccounts(values); load(values[kind]);
      })}>{uiText("停用服务")}</Button></div>
    </div>}
  </div>;
}
