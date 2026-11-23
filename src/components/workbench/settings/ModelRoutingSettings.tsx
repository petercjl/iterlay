import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Lock, Pencil, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUiText } from "@/i18n";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import { groupModelChannels, imageChannelOptions, resolveImageRouting, textModelRouteId, type ImageChannel, type ImageModelRouting, type OtherModelKind } from "@shared/image-routing";
import { getProviderModels } from "@shared/provider-models";
import type { AppSettings, ProviderConfig } from "@shared/types";
import type { NewModelChannel } from "@shared/contracts/settings";
import { DEFAULT_VIDEO_PROVIDER_ID, isCompanyModelChannel } from "@shared/contracts/providers";
import { COMMUNITY_IMAGE_PROVIDER, COMMUNITY_TEXT_PROVIDER } from "@shared/community-providers";
import { NewModelChannelForm } from "./NewModelChannelForm";

const kinds = { text: "文本模型", image: "图片模型", video: "视频模型", audio: "音频模型" } as const;
type Kind = keyof typeof kinds;
const channelKey = (channel: ImageChannel) => JSON.stringify([channel.providerId, channel.model]);
const selectClass = "h-9 min-w-0 rounded-md border bg-background px-2 text-sm";
export type RoutingSettings = Awaited<ReturnType<ReturnType<typeof getImageWorkbenchApi>["getSettings"]>>;

export function ModelRoutingSettings({ providers, activeProviderId, onRoutingSaved }: {
  providers: ProviderConfig[];
  activeProviderId: string;
  onRoutingSaved?: (settings: RoutingSettings) => void;
}) {
  const uiText = useUiText();
  const defaultFieldId = useId();
  const nameFieldId = useId();
  const [settings, setSettings] = useState<RoutingSettings>();
  const [kind, setKind] = useState<Kind>("text");
  const [drafts, setDrafts] = useState<Partial<Record<Kind, ImageModelRouting>>>({});
  const [selected, setSelected] = useState<Partial<Record<Kind, string>>>({});
  const [newName, setNewName] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [applyDefaults, setApplyDefaults] = useState<OtherModelKind[]>([]);
  const [newChannels, setNewChannels] = useState<NewModelChannel[]>([]);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [editing, setEditing] = useState<{ item: ImageChannel; draft: NewModelChannel }>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error?: boolean }>();
  const [signedIn, setSignedIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => getImageWorkbenchApi().getSettings()).then(value => {
      if (active) setSettings(value);
    }).catch(error => { if (active) setFeedback({ message: getWorkbenchErrorMessage(error), error: true }); });
    void Promise.resolve().then(() => getImageWorkbenchApi().enterpriseStatus())
      .then(status => { if (active) setSignedIn(status.authenticated); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function syncModels(): Promise<void> {
    setSyncing(true);
    setFeedback(undefined);
    try {
      const api = getImageWorkbenchApi();
      await api.refreshCompanyModels();
      const fresh = await api.getSettings();
      setSettings(fresh);
      onRoutingSaved?.(fresh);
      setFeedback({ message: uiText("模型配置已同步。") });
    } catch (error) {
      setFeedback({ message: getWorkbenchErrorMessage(error), error: true });
    } finally {
      setSyncing(false);
    }
  }

  const imageServices = providers.filter(provider => provider.id !== COMMUNITY_IMAGE_PROVIDER.id || settings?.providerKeyStatus[provider.id]);
  const services = kind === "image" ? imageServices : (kind === "text" ? settings?.textProviders
    : kind === "video" ? settings?.videoProviders : settings?.audioProviders) ?? [];
  const activeId = kind === "text" ? settings?.activeTextProviderId
    : kind === "video" ? settings?.activeVideoProviderId : settings?.activeAudioProviderId;
  const ordered = services.filter(service => !isCompanyModelChannel(service.id)).sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  const available = kind === "image" ? imageChannelOptions(imageServices.filter(service => !isCompanyModelChannel(service.id))) : ordered
    .filter(service => service.type !== "official" && service.baseUrl)
    .filter(service => ![COMMUNITY_TEXT_PROVIDER.id, DEFAULT_VIDEO_PROVIDER_ID].includes(service.id) || settings?.providerKeyStatus[service.id])
    .flatMap(service => getProviderModels(service).map(model => ({ providerId: service.id, model })));
  const personal = settings?.personalModelRouting;
  const routing = drafts[kind] ?? (kind === "image"
    ? resolveImageRouting(personal ? personal.image : settings?.imageRouting, imageServices.filter(service => !isCompanyModelChannel(service.id)), activeProviderId)
    : (personal ? personal.other?.[kind] : settings?.otherModelRouting?.[kind]) ?? groupModelChannels(available, ordered.find(service => service.id === activeId)?.model));
  const companyModels = settings?.companyModelRouting?.[kind].models ?? groupModelChannels(services.filter(service => isCompanyModelChannel(service.id))
    .flatMap(service => getProviderModels(service).map(model => ({ providerId: service.id, model })))
    .filter(ref => !routing.models.some(model => model.channels.some(channel => channelKey(channel) === channelKey(ref))))).models;
  const models = [...routing.models.map(model => ({ model, key: `local:${model.name}`, managed: false })),
    ...companyModels.map(model => ({ model, key: `company:${model.name}`, managed: true }))];
  const selection = models.find(item => item.key === selected[kind]);
  const current = selection?.model;
  const hasManagedChannel = current?.channels.some(item => isCompanyModelChannel(item.providerId));
  const defaultChoices = routing.models.filter(model => model.channels.some(channel =>
    settings?.providerKeyStatus[channel.providerId] || newChannels.some(draft => draft.providerId === channel.providerId &&
      (draft.apiKey || (draft.sourceProviderId && settings?.providerKeyStatus[draft.sourceProviderId])))));
  const activeService = services.find(service => service.id === (kind === "image" ? activeProviderId : activeId));
  const activeRoute = kind === "text" && activeId?.startsWith("text-route/")
    ? defaultChoices.find(model => textModelRouteId(model.name) === activeId)
    : defaultChoices.find(model => model.channels.some(channel => channel.providerId === activeService?.id && channel.model === activeService?.model));
  const chosenDefault = defaultChoices.find(model => model.name === routing.defaultModel);
  const defaultValue = kind === "image" || applyDefaults.includes(kind) ? chosenDefault?.name : activeRoute?.name;
  const shownManagedDefault = !defaultValue && activeService && isCompanyModelChannel(activeService.id) && (kind !== "image" || !settings?.imageRouting);
  const duplicateName = routing.models.some(model => model.name === newName.trim());
  const label = (item: ImageChannel) => isCompanyModelChannel(item.providerId) ? uiText("山海管理") :
    `${newChannels.find(service => service.providerId === item.providerId)?.name ?? services.find(service => service.id === item.providerId)?.name
      ?? uiText("渠道不可用")} · ${item.model}`;
  const disabled = !settings || busy;

  function change(next: ImageModelRouting) {
    setDrafts(previous => ({ ...previous, [kind]: next }));
    if (kind !== "image" && !next.models.some(model => model.name === next.defaultModel && model.channels.length))
      setApplyDefaults(previous => previous.filter(item => item !== kind));
    setFeedback(undefined);
  }

  function selectModel(key: string) {
    setSelected(previous => ({ ...previous, [kind]: key }));
    setCreatingChannel(false);
    setEditing(undefined);
  }

  function addModel() {
    const name = newName.trim();
    if (disabled || !name || duplicateName) return;
    change({ defaultModel: routing.defaultModel || name, models: [...routing.models, { name, channels: [] }] });
    selectModel(`local:${name}`);
    setNewName("");
    setAddingModel(false);
  }

  function chooseDefault(name: string) {
    if (!defaultChoices.some(model => model.name === name)) return;
    change({ ...routing, defaultModel: name });
    if (kind !== "image") setApplyDefaults(previous => previous.includes(kind) ? previous : [...previous, kind]);
  }

  function changeChannels(channels: ImageChannel[]) {
    if (current) change({ ...routing, models: routing.models.map(model => model === current ? { ...model, channels } : model) });
  }

  function moveChannel(index: number, delta: number) {
    if (!current) return;
    const channels = [...current.channels];
    const target = index + delta;
    if (target < 0 || target >= channels.length) return;
    if ([channels[index], channels[target]].some(channel => isCompanyModelChannel(channel.providerId))) return;
    [channels[index], channels[target]] = [channels[target], channels[index]];
    changeChannels(channels);
  }

  function edit(item: ImageChannel) {
    const staged = newChannels.find(channel => channel.providerId === item.providerId);
    if (staged) { setEditing({ item, draft: staged }); return; }
    const service = services.find(provider => provider.id === item.providerId);
    if (!service || service.type === "official" || service.type === "codex-oauth" || isCompanyModelChannel(service.id)) return;
    const source = "connectionProviderId" in service && service.connectionProviderId
      ? providers.find(provider => provider.id === service.connectionProviderId) : service;
    const protocol = kind === "image" ? (service as ProviderConfig).apiMode ?? "images"
      : kind === "text" ? (service as AppSettings["textProviders"][number]).protocol ?? "openai-chat-completions"
      : kind === "audio" ? "openai-speech" : (service as AppSettings["videoProviders"][number]).type as Exclude<AppSettings["videoProviders"][number]["type"], "official">;
    const shared = routing.models.flatMap(model => model.channels).filter(channel => channel.providerId === service.id).length > 1;
    setEditing({ item, draft: { kind, providerId: service.id.startsWith("local-channel-") && !shared ? service.id : `local-channel-${crypto.randomUUID()}`,
      sourceProviderId: service.id, name: service.name, baseUrl: source?.baseUrl ?? "", model: item.model, protocol,
      ...(kind === "audio" && "voice" in service ? { voice: service.voice } : {}),
      ...(kind === "image" ? { supportsReferenceImages: (service as ProviderConfig).supportsReferenceImages } : {}) } });
  }

  function stage(connection: NewModelChannel) {
    if (!current) return;
    const next = { providerId: connection.providerId, model: connection.model };
    setNewChannels(previous => [...previous.filter(other => other.providerId !== connection.providerId), connection]);
    changeChannels(editing ? current.channels.map(item => channelKey(item) === channelKey(editing.item) ? next : item) : [...current.channels, next]);
    setEditing(undefined);
    setCreatingChannel(false);
  }

  async function save() {
    if (disabled) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      const api = getImageWorkbenchApi();
      const other: NonNullable<AppSettings["otherModelRouting"]> = {};
      for (const candidate of ["text", "video", "audio"] satisfies OtherModelKind[]) {
        if (!drafts[candidate]) continue;
        other[candidate] = drafts[candidate];
      }
      await api.saveModelRouting({
        ...(drafts.image ? { imageRouting: drafts.image } : {}),
        ...(Object.keys(other).length ? { otherModelRouting: other } : {}),
        ...(applyDefaults.length ? { applyDefaults } : {}),
        channels: newChannels.filter(connection => drafts[connection.kind]?.models.some(model =>
          model.channels.some(ref => ref.providerId === connection.providerId)))
      });
      const saved = await api.getSettings();
      setSettings(saved);
      setDrafts({});
      setApplyDefaults([]);
      setNewChannels([]);
      onRoutingSaved?.(saved);
      setFeedback({ message: uiText("已保存到本机") });
    } catch (error) {
      setFeedback({ message: getWorkbenchErrorMessage(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return <Tabs value={kind} onValueChange={value => {
    setKind(value as Kind);
    setNewName("");
    setAddingModel(false);
    setCreatingChannel(false);
    setEditing(undefined);
  }} className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <TabsList aria-label={uiText("模型类型")}>
        {Object.entries(kinds).map(([value, name]) => <TabsTrigger key={value} value={value}>{uiText(name)}</TabsTrigger>)}
      </TabsList>
      <div className="flex gap-2">
        {signedIn && <Button type="button" size="sm" variant="outline" disabled={syncing || busy}
          onClick={() => void syncModels()}>{uiText(syncing ? "正在同步模型配置" : "同步模型配置")}</Button>}
        <Button type="button" size="sm" disabled={disabled || syncing || creatingChannel || Boolean(editing) || !Object.keys(drafts).length} onClick={() => void save()}>{uiText("保存模型设置")}</Button>
      </div>
    </div>
    {feedback && <p className={feedback.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"} role={feedback.error ? "alert" : "status"}>{feedback.message}</p>}
    <TabsContent value={kind} className="mt-0 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={defaultFieldId} className="shrink-0 text-sm font-medium">{uiText("默认模型")}</label>
        <select id={defaultFieldId} className={`${selectClass} flex-1`} value={defaultValue ?? ""} disabled={disabled || !defaultChoices.length}
          onChange={event => chooseDefault(event.target.value)}>
          <option value="" disabled>{shownManagedDefault ? `${activeService.name} · ${uiText("山海管理")}`
            : uiText(defaultChoices.length ? "选择默认模型" : "尚无已配置渠道的模型")}</option>
          {defaultChoices.map(model => <option key={model.name} value={model.name}>{model.name}</option>)}
        </select>
        <Dialog open={addingModel} onOpenChange={open => { setAddingModel(open); if (!open) setNewName(""); }}>
          <DialogTrigger asChild><Button type="button" variant="outline" disabled={disabled}>
            <Plus />{uiText("添加模型")}
          </Button></DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{uiText("添加模型")}</DialogTitle>
              <DialogDescription>{uiText("模型名称由你自定，方便识别即可。添加后，请在该模型中添加 API 渠道，配置完成后才能调用。")}</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={event => { event.preventDefault(); addModel(); }}>
              <div className="space-y-2">
                <label htmlFor={nameFieldId} className="text-sm font-medium">{uiText("模型名称")}</label>
                <Input id={nameFieldId} value={newName} maxLength={300} required aria-invalid={duplicateName || undefined}
                  onChange={event => setNewName(event.target.value)} />
                {duplicateName && <p role="alert" className="text-xs text-destructive">{uiText("此模型名称已存在。")}</p>}
              </div>
              <DialogFooter>
                <DialogClose asChild><Button type="button" variant="outline">{uiText("取消")}</Button></DialogClose>
                <Button type="submit" disabled={disabled || !newName.trim() || duplicateName}>{uiText("添加模型")}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(10rem,1fr)_minmax(19rem,1.65fr)]">
        <div className="overflow-hidden rounded-lg border" aria-label={uiText("模型列表")}>
          {models.length ? <ul className="divide-y">
            {models.map(({ model, key, managed }) => <li key={key}>
              <button type="button" aria-pressed={selection?.key === key} onClick={() => selectModel(key)}
                className="flex w-full items-center gap-2 px-3 py-3 text-left hover:bg-muted aria-pressed:bg-accent">
                <span className="min-w-0 flex-1 truncate text-sm font-medium" title={model.name}>{model.name}</span>
                {managed && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label={uiText("山海管理")} />}
                <span className="shrink-0 text-xs text-muted-foreground">{uiText("{{ui:0}} 条渠道", [model.channels.length])}</span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>)}
          </ul> : <p className="px-3 py-4 text-sm text-muted-foreground">{uiText("未配置模型")}</p>}
        </div>
        {current ? <section className="min-w-0 space-y-3 rounded-lg border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="break-words text-sm font-semibold">{current.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{uiText(kind === "image" ? "画板节点和创作助手按此顺序调用" : "渠道优先级从上到下")}</p>
            </div>
            {!selection?.managed && !hasManagedChannel && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => {
              const models = routing.models.filter(model => model !== current);
              change({ models, defaultModel: current.name === routing.defaultModel ? models[0]?.name ?? "" : routing.defaultModel });
              selectModel("");
            }}>{uiText("移除模型")}</Button>}
          </div>
          {current.channels.length ? <ol className="divide-y rounded-md border">
            {current.channels.map((item, index) => <li key={channelKey(item)} className="flex items-center gap-1 px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-sm" title={label(item)}>{index + 1}. {label(item)}</span>
              {isCompanyModelChannel(item.providerId) ? <Lock className="size-4 text-muted-foreground" aria-hidden /> : <>
                {(newChannels.some(channel => channel.providerId === item.providerId) || services.some(service => service.id === item.providerId && service.type !== "official" && service.type !== "codex-oauth")) &&
                  <Button type="button" size="icon" variant="ghost" disabled={disabled} title={uiText("编辑渠道")} aria-label={uiText("编辑渠道")} onClick={() => { setCreatingChannel(false); edit(item); }}><Pencil /></Button>}
                <Button type="button" size="icon" variant="ghost" disabled={disabled || index === 0 || isCompanyModelChannel(current.channels[index - 1]?.providerId)} aria-label={uiText("上移渠道")} onClick={() => moveChannel(index, -1)}><ArrowUp /></Button>
                <Button type="button" size="icon" variant="ghost" disabled={disabled || index === current.channels.length - 1 || isCompanyModelChannel(current.channels[index + 1]?.providerId)} aria-label={uiText("下移渠道")} onClick={() => moveChannel(index, 1)}><ArrowDown /></Button>
                <Button type="button" size="icon" variant="ghost" disabled={disabled || Boolean(editing)} aria-label={uiText("移除渠道")} onClick={() => changeChannels(current.channels.filter(other => item !== other))}><X /></Button>
              </>}
            </li>)}
          </ol> : <p className="text-sm text-muted-foreground">{uiText("尚未添加渠道")}</p>}
          {!selection?.managed && (creatingChannel || editing
            ? <NewModelChannelForm key={editing ? channelKey(editing.item) : "new"} kind={kind} disabled={disabled} initial={editing?.draft}
              hasSavedKey={Boolean(editing?.draft.sourceProviderId && settings?.providerKeyStatus[editing.draft.sourceProviderId])}
              onCancel={() => { setCreatingChannel(false); setEditing(undefined); }} onAdd={stage} />
            : <Button type="button" variant="outline" disabled={disabled} onClick={() => setCreatingChannel(true)}>
              <Plus />{uiText("添加渠道")}
            </Button>)}
        </section> : <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {uiText("选择一个模型以配置渠道。")}
        </div>}
      </div>
    </TabsContent>
  </Tabs>;
}
