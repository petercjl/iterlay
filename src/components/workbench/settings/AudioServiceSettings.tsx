import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUiText } from "@/i18n";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import type { AudioProviderConfig } from "@shared/types";

const empty = { name: "", baseUrl: "", model: "", voice: "alloy", speechEndpoint: "/v1/audio/speech" };

export function AudioServiceSettings() {
  const uiText = useUiText();
  const [providers, setProviders] = useState<AudioProviderConfig[]>([]);
  const [draft, setDraft] = useState<(typeof empty & { id?: string })>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => getImageWorkbenchApi().getSettings()).then(value => {
      if (active) setProviders(value.audioProviders ?? []);
    }).catch(value => { if (active) setError(getWorkbenchErrorMessage(value)); });
    return () => { active = false; };
  }, []);

  function edit(provider?: AudioProviderConfig) {
    setDraft(provider ?? { ...empty });
    setKey("");
    setError("");
  }

  async function persist(action: "upsert" | "remove") {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const api = getImageWorkbenchApi();
      await api.configureProvider(action === "remove"
        ? { kind: "audio", action, providerId: draft.id }
        : { kind: "audio", action, providerId: draft.id, name: draft.name, baseUrl: draft.baseUrl,
          model: draft.model, voice: draft.voice, speechEndpoint: draft.speechEndpoint, ...(key.trim() ? { apiKey: key.trim() } : {}) });
      setProviders((await api.getSettings()).audioProviders ?? []);
      setDraft(undefined);
      setKey("");
    } catch (value) {
      setError(getWorkbenchErrorMessage(value));
    } finally {
      setBusy(false);
    }
  }

  return <section className="space-y-3" aria-label={uiText("音频服务")}>
    <div className="model-section-heading">
      <h3>{uiText("音频服务")}</h3>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => edit()}><Plus />{uiText("添加音频服务")}</Button>
    </div>
    {providers.length > 0 && <ul className="divide-y rounded-lg border">
      {providers.map(provider => <li key={provider.id}>
        <button type="button" disabled={busy} className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
          onClick={() => edit(provider)}>
          <span className="min-w-0 truncate">{provider.name}</span>
          <span className="min-w-0 truncate text-muted-foreground">{provider.model}</span>
        </button>
      </li>)}
    </ul>}
    {draft && <form className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2" onSubmit={event => {
      event.preventDefault();
      void persist("upsert");
    }}>
      {([
        ["name", "服务名称"],
        ["baseUrl", "Base URL"],
        ["model", "模型名称"],
        ["speechEndpoint", "语音接口路径"],
        ["voice", "默认声音"],
      ] as const).map(([field, label]) => <label key={field} className="space-y-1 text-sm">
        <span>{uiText(label)}</span>
        <Input required value={draft[field]} disabled={busy} onChange={event => setDraft({ ...draft, [field]: event.target.value })} />
      </label>)}
      <label className="space-y-1 text-sm">
        <span>API Key</span>
        <Input type="password" autoComplete="off" value={key} disabled={busy} onChange={event => setKey(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy}>{uiText("保存更改")}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => {setDraft(undefined);setKey("");setError("");}}>{uiText("取消")}</Button>
        {draft.id && <Button type="button" variant="ghost" disabled={busy} onClick={() => {
          if (window.confirm(uiText("删除此服务？"))) void persist("remove");
        }}>{uiText("删除服务")}</Button>}
      </div>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
