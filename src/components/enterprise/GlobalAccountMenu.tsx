import { useUiText } from "@/i18n";
import { useRef, useState } from "react";
import { LogOut, Settings } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import { useEnterpriseStatus } from "./use-enterprise";
import { AccountAvatar } from "./AccountAvatar";

/** One account control, mounted above every authenticated workspace entrance. */
export function GlobalAccountMenu({ compact = false, floating = false, onOpenSettings }: {
  compact?: boolean;
  floating?: boolean;
  onOpenSettings: () => void;
}) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [signingOut, setSigningOut] = useState(false);
  const openingSettings = useRef(false);
  if (!status?.authenticated) return null;
  const displayName = status.accountNickname || status.user?.name || uiText("Tuda 用户");

  async function signOut() {
    setSigningOut(true);
    try {
      await getImageWorkbenchApi().enterpriseLogout();
    } catch (error) {
      toast.error(getWorkbenchErrorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <button type="button" aria-label={uiText("账号菜单：{{ui:0}}", [displayName])} title={displayName} data-global-account
        disabled={signingOut}
        className={`tuda-global-account-trigger flex items-center gap-2 rounded-lg p-2 text-left transition hover:bg-accent data-[state=open]:bg-accent [-webkit-app-region:no-drag] ${floating ? "fixed bottom-2 left-2 z-[49] bg-background/90 shadow-sm ring-1 ring-border/60" : "w-full shrink-0"} ${compact ? "justify-center" : ""}`}>
        <AccountAvatar name={displayName} url={status.user?.avatarUrl} />
        {!compact && <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{displayName}</span><span className="block truncate text-xs text-muted-foreground">{status.organizationName}</span></span>}
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start" className="[-webkit-app-region:no-drag]"
      onCloseAutoFocus={(event) => {
        if (!openingSettings.current) return;
        openingSettings.current = false;
        event.preventDefault();
      }}>
      <DropdownMenuItem onSelect={() => {
        openingSettings.current = true;
        onOpenSettings();
      }}>
        <Settings className="size-4" aria-hidden="true" />
        {uiText("设置")}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void signOut()}>
        <LogOut className="size-4" aria-hidden="true" />
        {uiText("退出登录")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
