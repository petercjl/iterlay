import { Check, ChevronDown } from "lucide-react";
import { useUiText } from "@/i18n";
import type { TextProviderConfig } from "@shared/types";
import { defaultTudaTextProvider } from "@shared/tuda-models";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function modelLabel(provider: TextProviderConfig) {
  if (provider.managed && provider.connectionName) return provider.name;
  const connection = provider.connectionName || provider.name;
  const model = provider.connectionName ? provider.name : provider.model;
  return connection && model && connection !== model ? `${connection} · ${model}` : connection || model;
}

export function TextModelPicker({ providers, activeProviderId, disabled, onSelect, onManage }: {
  providers: TextProviderConfig[];
  activeProviderId?: string;
  disabled?: boolean;
  onSelect?: (id: string) => void;
  onManage: () => void;
}): React.ReactElement {
  const uiText = useUiText();
  const selected = defaultTudaTextProvider(providers, activeProviderId);
  const provider = providers.find((item) => item.id === selected);
  const connections = new Map<string, TextProviderConfig[]>();
  for (const item of providers) {
    const name = item.connectionName || item.name;
    const models = connections.get(name);
    if (models) models.push(item);
    else connections.set(name, [item]);
  }
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} className="create-chat-model inline-flex h-8 max-w-64 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent" aria-label={uiText("选择文本模型")} title={provider ? modelLabel(provider) : uiText("选择文本模型")}>
        <span className="truncate">{provider ? modelLabel(provider) : uiText("选择文本模型")}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" side="top" sideOffset={10} className="w-72 max-h-80 overflow-y-auto">
      {providers.length === 0 ? <DropdownMenuLabel>{uiText("文本模型")}</DropdownMenuLabel> : null}
      {[...connections].map(([connection, models]) => <DropdownMenuGroup key={connection} aria-label={uiText(connection)}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">{uiText(connection)}</DropdownMenuLabel>
        {models.map((item) => <DropdownMenuItem key={item.id} onSelect={() => onSelect?.(item.id)}>
          <span className="min-w-0 flex-1"><span className="block truncate">{item.connectionName ? item.name : item.model || item.name}</span>{item.connectionName && item.name !== item.model ? <span className="block truncate text-xs text-muted-foreground">{item.model}</span> : null}</span>
          {item.id === selected ? <Check size={14} aria-hidden="true" /> : null}
        </DropdownMenuItem>)}
      </DropdownMenuGroup>)}
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={onManage}>{uiText("管理文本模型")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
