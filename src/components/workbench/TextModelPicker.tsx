import { Check, ChevronDown } from "lucide-react";
import { useUiText } from "@/i18n";
import type { TextProviderConfig } from "@shared/types";
import { defaultTudaTextProvider } from "@shared/tuda-models";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} className="create-chat-model inline-flex h-8 max-w-64 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent" aria-label={uiText("选择文本模型")} title={provider ? `${provider.name} · ${provider.model}` : uiText("选择文本模型")}>
        <span className="truncate">{provider?.name || provider?.model || uiText("选择文本模型")}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" side="top" sideOffset={10} className="w-72 max-h-80 overflow-y-auto">
      <DropdownMenuLabel>{uiText("文本模型")}</DropdownMenuLabel>
      {providers.map((item) => <DropdownMenuItem key={item.id} onSelect={() => onSelect?.(item.id)}>
        <span className="min-w-0 flex-1"><span className="block truncate">{item.name || item.model}</span>{item.name !== item.model ? <span className="block truncate text-xs text-muted-foreground">{item.model}</span> : null}</span>
        {item.id === selected ? <Check size={14} aria-hidden="true" /> : null}
      </DropdownMenuItem>)}
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={onManage}>{uiText("管理文本模型")}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
