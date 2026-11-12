import { useUiText } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import {
  Building2,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  FolderOpen,
  Loader2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getImageWorkbenchApi,
  getWorkbenchErrorMessage,
} from "@/lib/image-workbench-api";
import type { EnterpriseMember, EnterpriseRole } from "@shared/enterprise";
import type { BoardSummary } from "@shared/types";
import { MemberProviders } from "./MemberProviders";
import { useEnterpriseStatus } from "./use-enterprise";

export function SpaceControl({ compact = false }: { compact?: boolean }) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [open, setOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [nasUrl, setNasUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loginExpires, setLoginExpires] = useState("");
  const [members, setMembers] = useState<Array<
    EnterpriseMember & { active: boolean }
  > | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [copyId, setCopyId] = useState("");
  const polling = useRef(false);
  useEffect(() => {
    if (status?.serverUrl) setServerUrl(status.serverUrl);
  }, [status?.serverUrl]);
  useEffect(() => {
    if (status?.storageUrl) setNasUrl(status.storageUrl);
  }, [status?.storageUrl]);
  useEffect(() => {
    if (status?.activeSpace === "enterprise" && !status.authenticated)
      setOpen(true);
  }, [status?.activeSpace, status?.authenticated]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (value) {
      setError(getWorkbenchErrorMessage(value, uiText("操作失败，请重试。")));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!loginExpires) return;
    const timer = window.setInterval(() => {
      if (polling.current) return;
      if (Date.parse(loginExpires) < Date.now()) {
        setLoginExpires("");
        setError(uiText("登录请求已过期，请重新发起。"));
        return;
      }
      polling.current = true;
      void getImageWorkbenchApi()
        .pollEnterpriseLogin()
        .then((result) => {
          if (result.status === "authorized") {
            setLoginExpires("");
            setOpen(false);
          }
        })
        .catch((value) => {
          setError(getWorkbenchErrorMessage(value));
          setLoginExpires("");
        })
        .finally(() => {
          polling.current = false;
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loginExpires, uiText]);
  if (!status) return null;
  const company = status.activeSpace === "enterprise";
  const kind = status.authenticated ? (status.storageKind ?? "nas") : "nas";
  const folderName = status.localFolder?.split(/[\\/]/).filter(Boolean).at(-1);
  const selectNas = () =>
    run(async () => {
      if (kind === "nas" && company && status.connected) return;
      if (status.accountMode !== "shared") {
        await getImageWorkbenchApi().selectSpace("enterprise");
        return;
      }
      if (!nasUrl.trim())
        throw new Error(uiText("默认 NAS 地址尚未配置，请联系管理员。"));
      await getImageWorkbenchApi().chooseCompanyNas(nasUrl.trim());
    });
  return (
    <>
      <button
        type="button"
        aria-label={uiText("切换个人与企业空间")}
        data-space={status.activeSpace}
        onClick={() => setOpen(true)}
        className={`flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/70 text-xs [-webkit-app-region:no-drag] ${compact ? "px-2 py-1.5" : "mx-4 mb-3 px-3 py-2.5"}`}
      >
        {company ? (
          <Building2 className="h-4 w-4 shrink-0 text-blue-500" />
        ) : (
          <UserRound className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate">
          {company
            ? status.organizationName || uiText("企业空间")
            : uiText("个人空间")}
        </span>
        {company &&
          (status.connected ? (
            <Cloud
              aria-label={uiText("企业已连接")}
              className="h-3.5 w-3.5 text-emerald-500"
            />
          ) : (
            <CloudOff
              aria-label={uiText("企业未连接")}
              className="h-3.5 w-3.5 text-amber-500"
            />
          ))}
        {company && status.peers.length > 0 && (
          <span>
            {status.peers.length + 1} {uiText("人")}
          </span>
        )}
        <ChevronDown className="ml-auto h-3 w-3 shrink-0" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85vh] overflow-auto sm:max-w-[460px]"
          data-enterprise-dialog
        >
          <DialogHeader>
            <DialogTitle>{uiText("存储空间")}</DialogTitle>
            <DialogDescription>
              {uiText("选择公司画板的保存位置。")}
            </DialogDescription>
          </DialogHeader>
          {status.authenticated ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4" />
              <span>{status.organizationName}</span>
              <span className="text-border">/</span>
              <span>{status.user?.name}</span>
            </div>
          ) : (
            <Button
              disabled={busy || !status.configured || Boolean(loginExpires)}
              onClick={() =>
                void run(async () => {
                  const result =
                    await getImageWorkbenchApi().beginEnterpriseLogin();
                  setLoginExpires(result.expiresAt);
                })
              }
            >
              {loginExpires ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {uiText("等待浏览器完成钉钉登录")}
                </>
              ) : (
                uiText("使用钉钉登录企业空间")
              )}
            </Button>
          )}
          <div
            role="radiogroup"
            aria-label={uiText("公司画板存储")}
            className="grid grid-cols-2 gap-3"
          >
            {(["nas", "local"] as const).map((value) => {
              const selected = kind === value;
              const Icon = value === "nas" ? Cloud : FolderOpen;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy || !status.authenticated}
                  onClick={() => {
                    if (value === "nas") void selectNas();
                    else if (kind !== "local" || !company)
                      void run(() =>
                        getImageWorkbenchApi().chooseCompanyLocalFolder(true),
                      );
                  }}
                  className={`relative flex min-h-32 flex-col items-start rounded-xl border p-4 text-left transition-colors disabled:cursor-default disabled:opacity-60 ${selected ? "border-blue-500 bg-blue-500/5 ring-1 ring-blue-500" : "border-border hover:bg-muted/50"}`}
                >
                  <div className="mb-4 flex w-full items-center justify-between">
                    <Icon
                      className={`h-5 w-5 ${selected ? "text-blue-500" : "text-muted-foreground"}`}
                    />
                    {selected ? (
                      <Check className="h-4 w-4 text-blue-500" />
                    ) : null}
                  </div>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {value === "nas" ? uiText("NAS 空间") : uiText("本地空间")}
                    {value === "nas" && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                        {uiText("默认")}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {value === "nas"
                      ? uiText("团队共享，支持多人协作")
                      : uiText("仅保存在这台电脑")}
                  </span>
                </button>
              );
            })}
          </div>
          {status.authenticated && kind === "local" && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {folderName || uiText("尚未选择文件夹")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="shrink-0"
                onClick={() =>
                  void run(() =>
                    getImageWorkbenchApi().chooseCompanyLocalFolder(),
                  )
                }
              >
                {uiText("更换文件夹")}
              </Button>
            </div>
          )}
          {status.authenticated && kind === "nas" && (
            <p
              className={`flex items-center gap-1.5 text-xs ${status.connected ? "text-emerald-600" : "text-amber-600"}`}
            >
              {status.connected ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {uiText("已连接")}
                </>
              ) : (
                uiText("NAS 暂时不可用，可切换本地空间。")
              )}
            </p>
          )}
          {Boolean(status.pendingWrites) && (
            <p className="text-xs text-amber-600">{uiText("有修改等待同步")}</p>
          )}
          {kind === "local" && Boolean(status.nasPendingWrites) && (
            <p className="text-xs text-amber-600">
              {uiText("待同步的 NAS 修改已保留在本机。")}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <details className="group border-t pt-3" data-company-advanced>
            <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
              {uiText("高级设置")}
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            </summary>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="enterprise-server-url"
                  className="text-xs font-medium"
                >
                  {uiText("公司账号服务地址")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="enterprise-server-url"
                    value={serverUrl}
                    onChange={(event) => setServerUrl(event.target.value)}
                    autoComplete="off"
                  />
                  <Button
                    className="shrink-0"
                    variant="outline"
                    disabled={busy || !serverUrl.trim()}
                    onClick={() =>
                      void run(() =>
                        getImageWorkbenchApi().configureEnterprise(
                          serverUrl.trim(),
                        ),
                      )
                    }
                  >
                    {uiText("连接")}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="company-nas-url"
                  className="text-xs font-medium"
                >
                  {uiText("公司 NAS 存储地址")}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="company-nas-url"
                    value={nasUrl}
                    onChange={(event) => setNasUrl(event.target.value)}
                    autoComplete="off"
                  />
                  <Button
                    className="shrink-0"
                    variant="outline"
                    disabled={busy || !status.authenticated || !nasUrl.trim()}
                    onClick={() =>
                      void run(() =>
                        getImageWorkbenchApi().chooseCompanyNas(nasUrl.trim()),
                      )
                    }
                  >
                    {uiText("连接")}
                  </Button>
                </div>
              </div>
              {status.authenticated && (
                <>
                  <p className="break-all text-xs text-muted-foreground">
                    {uiText("公司本地文件夹")}：
                    {status.localFolder || uiText("尚未选择")}
                  </p>
                  {status.accountMode === "shared" && (
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {uiText("文本模型")}：{status.textModels ?? 0} ·{" "}
                        {uiText("生图模型")}：{status.imageModels ?? 0}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            getImageWorkbenchApi().refreshCompanyModels(),
                          )
                        }
                      >
                        {uiText("刷新模型授权")}
                      </Button>
                    </div>
                  )}
                  {status.accountMode === "shared" && !status.imageModels && (
                    <p className="text-xs text-muted-foreground">
                      {uiText(
                        "生图授权需要管理员核实并绑定本人 ToAPIs Key，文本模型可独立使用。",
                      )}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !company}
                      onClick={() =>
                        void run(() =>
                          getImageWorkbenchApi().selectSpace("personal"),
                        )
                      }
                    >
                      {uiText("个人空间")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || company}
                      onClick={() =>
                        void run(() =>
                          getImageWorkbenchApi().selectSpace("enterprise"),
                        )
                      }
                    >
                      {uiText("企业空间")}
                    </Button>
                    {status.pendingWrites > 0 && (
                      <Button
                        size="sm"
                        disabled={busy}
                        variant="outline"
                        onClick={() =>
                          void run(() =>
                            getImageWorkbenchApi().retryEnterpriseSync(),
                          )
                        }
                      >
                        {uiText("重试同步")}
                      </Button>
                    )}
                  </div>
                  {status.accountMode !== "shared" &&
                    status.activeSpace === "personal" && (
                      <details
                        className="rounded-lg border p-3"
                        onToggle={(event) => {
                          if (event.currentTarget.open)
                            void getImageWorkbenchApi()
                              .listBoards()
                              .then(setBoards)
                              .catch(() => undefined);
                        }}
                      >
                        <summary className="cursor-pointer text-sm">
                          {uiText("复制个人画板到企业空间")}
                        </summary>
                        <div className="mt-3 flex gap-2">
                          <select
                            aria-label={uiText("选择要复制的个人画板")}
                            className="min-w-0 flex-1 rounded border bg-background px-2 text-sm"
                            value={copyId}
                            onChange={(event) => setCopyId(event.target.value)}
                          >
                            <option value="">{uiText("选择画板")}</option>
                            {boards.map((board) => (
                              <option key={board.id} value={board.id}>
                                {board.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            disabled={!copyId || busy}
                            onClick={() =>
                              void run(async () => {
                                const value =
                                  await getImageWorkbenchApi().copyBoardToEnterprise(
                                    copyId,
                                  );
                                toast.success(
                                  `已复制「${value.name}」到企业空间`,
                                );
                              })
                            }
                          >
                            {uiText("复制")}
                          </Button>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {uiText("保留本机原画板，复制画板及关联素材。")}
                        </p>
                      </details>
                    )}
                  {status.accountMode !== "shared" &&
                    status.user?.role === "admin" && (
                      <details
                        className="rounded-lg border p-3"
                        onToggle={(event) => {
                          if (event.currentTarget.open)
                            void run(async () =>
                              setMembers(
                                await getImageWorkbenchApi().enterpriseMembers(),
                              ),
                            );
                        }}
                      >
                        <summary className="cursor-pointer text-sm">
                          {uiText("企业成员与权限")}
                        </summary>
                        <div className="mt-3 space-y-3">
                          {members?.map((member) => (
                            <div
                              key={member.id}
                              className="space-y-1 border-b pb-2 last:border-0"
                            >
                              <div className="flex items-center gap-2 text-sm">
                                <span className="min-w-0 flex-1 truncate">
                                  {member.name}
                                </span>
                                <select
                                  aria-label={`${member.name}的权限`}
                                  className="rounded border bg-background px-2 py-1"
                                  value={member.role}
                                  disabled={busy}
                                  onChange={(event) =>
                                    void run(async () => {
                                      await getImageWorkbenchApi().updateEnterpriseMember(
                                        {
                                          id: member.id,
                                          role: event.target
                                            .value as EnterpriseRole,
                                          active: member.active,
                                        },
                                      );
                                      setMembers(
                                        await getImageWorkbenchApi().enterpriseMembers(),
                                      );
                                    })
                                  }
                                >
                                  <option value="viewer">
                                    {uiText("只读")}
                                  </option>
                                  <option value="editor">
                                    {uiText("编辑")}
                                  </option>
                                  <option value="admin">
                                    {uiText("管理")}
                                  </option>
                                </select>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () => {
                                      await getImageWorkbenchApi().updateEnterpriseMember(
                                        {
                                          id: member.id,
                                          role: member.role,
                                          active: !member.active,
                                        },
                                      );
                                      setMembers(
                                        await getImageWorkbenchApi().enterpriseMembers(),
                                      );
                                    })
                                  }
                                >
                                  {member.active
                                    ? uiText("停用")
                                    : uiText("启用")}
                                </Button>
                              </div>
                              <MemberProviders
                                member={member}
                                run={run}
                                busy={busy}
                              />
                            </div>
                          )) ?? (
                            <p className="text-xs text-muted-foreground">
                              {uiText("正在读取成员…")}
                            </p>
                          )}
                        </div>
                      </details>
                    )}

                  <Button
                    size="sm"
                    disabled={busy}
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() =>
                      void run(() => getImageWorkbenchApi().enterpriseLogout())
                    }
                  >
                    {uiText("退出企业登录")}
                  </Button>
                </>
              )}
              {status.error && (
                <p role="alert" className="text-xs text-destructive">
                  {status.error}
                </p>
              )}
            </div>
          </details>
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {uiText("正在处理…")}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
