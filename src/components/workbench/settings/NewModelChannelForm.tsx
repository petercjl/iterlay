import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { NewModelChannel } from "@shared/contracts/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUiText } from "@/i18n";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";

const protocols = {
  text: [
    ["openai-chat-completions", "OpenAI Chat Completions"],
    ["openai-responses", "OpenAI Responses"],
    ["anthropic-messages", "Anthropic Messages"]
  ],
  image: [["images", "OpenAI Images"], ["responses", "OpenAI Responses"]],
  video: [["ark", "火山方舟"], ["fal", "fal.ai"], ["openrouter", "OpenRouter"], ["minimax", "MiniMax"], ["seedance-aipai", "AI派 Seedance"], ["seedance-toapis", "ToAPIs Seedance"]],
  audio: [["openai-speech", "OpenAI Speech"]]
} as const;

export function NewModelChannelForm({ kind, disabled, initial, hasSavedKey, onAdd, onCancel }: {
  kind: NewModelChannel["kind"];
  disabled: boolean;
  initial?: NewModelChannel;
  hasSavedKey?: boolean;
  onAdd: (channel: NewModelChannel) => void;
  onCancel: () => void;
}) {
  const uiText = useUiText();
  const keyFieldId = useId();
  const [showKey, setShowKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string>();
  const [loadingKey, setLoadingKey] = useState(false);
  const [keyError, setKeyError] = useState<string>();
  const [draft, setDraft] = useState(() => ({
    name: "", baseUrl: "", model: "", apiKey: "", protocol: protocols[kind][0][0] as NewModelChannel["protocol"],
    supportsReferenceImages: false, voice: "alloy", ...initial
  }));
  const needsKey = !initial || (!initial.apiKey && !initial.sourceProviderId);
  const fields = [["name", "渠道名称"], ["baseUrl", "Base URL"], ["model", "厂商模型 ID"]] as const;

  async function toggleKey() {
    if (showKey) {
      setRevealedKey(undefined);
      setShowKey(false);
      return;
    }
    setKeyError(undefined);
    if (initial?.sourceProviderId && hasSavedKey && !draft.apiKey) {
      setLoadingKey(true);
      try {
        const key = await getImageWorkbenchApi().revealLocalModelChannelKey(kind, initial.sourceProviderId);
        if (!key) throw new Error(uiText("无法读取已保存的 API Key。"));
        setRevealedKey(key);
      } catch (error) {
        setKeyError(getWorkbenchErrorMessage(error));
        return;
      } finally {
        setLoadingKey(false);
      }
    }
    setShowKey(true);
  }

  return <form className="grid gap-3 rounded-lg border bg-muted/25 p-3" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    onAdd({ providerId: initial?.providerId ?? `local-channel-${crypto.randomUUID()}`, kind, name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), protocol: draft.protocol,
      ...(draft.apiKey?.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      ...(initial?.sourceProviderId ? { sourceProviderId: initial.sourceProviderId } : {}),
      ...(kind === "image" ? { supportsReferenceImages: draft.supportsReferenceImages } : {}),
      ...(kind === "audio" ? { voice: draft.voice?.trim() } : {}) });
  }}>
    <h4 className="text-sm font-medium">{uiText(initial ? "编辑渠道" : "新建 API 渠道")}</h4>
    {fields.map(([field, label]) => <label key={field} className="grid gap-1 text-sm">
      <span>{uiText(label)}</span>
      <Input required disabled={disabled} type={field === "baseUrl" ? "url" : "text"}
        autoComplete="off" spellCheck={false} maxLength={field === "baseUrl" ? 2048 : 300} value={draft[field] ?? ""}
        onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))} />
    </label>)}
    <div className="grid gap-1 text-sm">
      <label htmlFor={keyFieldId}>{uiText("API Key")}</label>
      <div className="relative">
        <Input id={keyFieldId} className="pr-10" required={needsKey} disabled={disabled || loadingKey} type={showKey ? "text" : "password"}
          autoComplete="off" spellCheck={false} maxLength={4096} value={draft.apiKey || revealedKey || ""}
          placeholder={hasSavedKey ? "••••••••••••" : undefined}
          onChange={event => {
            const apiKey = event.target.value;
            setRevealedKey(undefined);
            setDraft(previous => ({ ...previous, apiKey }));
          }} />
        <Button type="button" size="icon" variant="ghost" className="absolute inset-y-0 right-0"
          aria-controls={keyFieldId} aria-label={uiText(showKey ? "隐藏 API Key" : "显示 API Key")}
          disabled={disabled || loadingKey || (!hasSavedKey && !draft.apiKey)} onClick={() => void toggleKey()}>
          {showKey ? <EyeOff /> : <Eye />}
        </Button>
      </div>
      {keyError && <p role="alert" className="text-xs text-destructive">{keyError}</p>}
    </div>
    {initial?.sourceProviderId && <p className="text-xs text-muted-foreground">{uiText("留空保留原 API Key，更换服务域名时请填写新密钥。")}</p>}
    <label className="grid gap-1 text-sm">
      <span>{uiText("接口协议")}</span>
      <select className="h-9 rounded-md border bg-background px-2" disabled={disabled} value={draft.protocol}
        onChange={event => setDraft(previous => ({ ...previous, protocol: event.target.value as NewModelChannel["protocol"] }))}>
        {protocols[kind].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    {kind === "image" && <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" disabled={disabled} checked={draft.supportsReferenceImages}
        onChange={event => setDraft(previous => ({ ...previous, supportsReferenceImages: event.target.checked }))} />
      {uiText("支持参考图")}
    </label>}
    {kind === "audio" && <label className="grid gap-1 text-sm">
      <span>{uiText("音色")}</span><Input required value={draft.voice ?? ""} disabled={disabled} onChange={event => setDraft(previous => ({ ...previous, voice: event.target.value }))} />
    </label>}
    <div className="flex gap-2">
      <Button type="submit" size="sm" disabled={disabled || fields.some(([field]) => !draft[field].trim()) || needsKey && !draft.apiKey?.trim()}>{uiText(initial ? "保存渠道" : "添加渠道")}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{uiText("取消")}</Button>
    </div>
  </form>;
}
