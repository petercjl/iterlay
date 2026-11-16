import { useUiText } from "@/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { useEnterpriseStatus } from "./use-enterprise";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import logo from "@/assets/app-icon-default.png";

/** The workspace is mounted only after company verification and tool setup. */
export function CompanyLoginGate({ children }: { children: ReactNode }) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expires, setExpires] = useState(0);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"dingtalk" | "password">("dingtalk");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const polling = useRef(false);
  useEffect(() => {
    if (ready && status?.authenticated && status.accountMode === "shared") return;
    const api = getImageWorkbenchApi();
    const stop = api.onWindowSaveRequest(request => api.completeWindowSave({ requestId: request.requestId, ok: true }));
    api.windowRendererReady();
    return stop;
  }, [ready, status?.authenticated, status?.accountMode]);
  useEffect(() => {
    setReady(false);
    if (!status?.authenticated || status.accountMode !== "shared") return;
    let alive = true;
    setError(""); setBusy(true);
    const api = getImageWorkbenchApi();
    void api.refreshCompanyModels().then(async () => {
      await api.getPiAgentResources();
      if (alive) setReady(true);
    }).catch(value => { if (alive) setError(getWorkbenchErrorMessage(value)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [status?.authenticated, status?.accountMode, attempt]);
  useEffect(() => {
    if (!expires) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= expires) { setExpires(0); setBusy(false); setError(uiText("登录已超时，请重新登录。")); return; }
      if (polling.current) return;
      polling.current = true;
      void getImageWorkbenchApi().pollEnterpriseLogin().then(result => {
        if (result.status === "authorized") { setExpires(0); setBusy(false); }
      }).catch(value => { setError(getWorkbenchErrorMessage(value)); setExpires(0); setBusy(false); })
        .finally(() => { polling.current = false; });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [expires, uiText]);
  const login = async () => {
    setError(""); setBusy(true);
    try { const result = await getImageWorkbenchApi().beginEnterpriseLogin(); setExpires(Date.parse(result.expiresAt)); }
    catch (value) { setError(getWorkbenchErrorMessage(value)); setBusy(false); }
  };
  const passwordLogin = async () => {
    setError(""); setBusy(true);
    try { await getImageWorkbenchApi().beginEnterpriseLogin({ username: username.trim(), password }); setPassword(""); }
    catch (value) { setError(getWorkbenchErrorMessage(value)); }
    finally { setBusy(false); }
  };
  if (ready && status?.authenticated && status.accountMode === "shared") return <>{children}</>;
  return <main className="flex h-dvh items-center justify-center bg-background p-6 text-foreground" data-company-login-gate>
    <section className="w-full max-w-md rounded-3xl border border-border bg-card p-10 text-center text-card-foreground shadow-sm">
      <img src={logo} alt="Tuda" className="mx-auto mb-5 h-20 w-20 rounded-2xl" />
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">{uiText("Tuda · 图塔")}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{status?.authenticated ? uiText("正在准备你的工作区…") : uiText("登录 Tuda，开始创作。")}</p>
      <div className="my-7 flex items-center justify-center gap-2 text-sm text-muted-foreground"><ShieldCheck className="size-4" />{uiText("苏州东轩塑料制品有限公司")}</div>
      {error && <p role="alert" className="mb-5 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {!status ? <p className="text-sm text-muted-foreground">{uiText("正在连接公司账号服务…")}</p>
        : status.accountMode !== "shared" || !status.configured ? <p role="alert" className="text-sm text-destructive">{uiText("公司账号服务尚未配置，请联系管理员。")}</p>
        : status.authenticated ? <button type="button" onClick={() => setAttempt(value => value + 1)} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-medium text-white disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />}{busy ? uiText("正在验证登录并准备创作工具…") : uiText("重试连接")}</button>
        : <>
          <div className="mb-5 flex gap-2" aria-label={uiText("登录方式")}>
            <button type="button" disabled={busy} aria-pressed={mode === "dingtalk"} onClick={() => setMode("dingtalk")} className={`flex-1 rounded-xl py-2 text-sm ${mode === "dingtalk" ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}>{uiText("钉钉登录")}</button>
            <button type="button" disabled={busy} aria-pressed={mode === "password"} onClick={() => setMode("password")} className={`flex-1 rounded-xl py-2 text-sm ${mode === "password" ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}>{uiText("账号密码登录")}</button>
          </div>
          {mode === "password" ? <form onSubmit={event => { event.preventDefault(); void passwordLogin(); }} className="space-y-3 text-left">
            <label className="block text-sm font-medium text-foreground">{uiText("账号")}<input autoComplete="username" aria-label={uiText("账号")} maxLength={64} value={username} onChange={event => setUsername(event.target.value)} required disabled={busy} className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-foreground caret-blue-600 dark:caret-blue-400" /></label>
            <label className="block text-sm font-medium text-foreground">{uiText("密码")}<input type="password" autoComplete="current-password" aria-label={uiText("密码")} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-foreground caret-blue-600 dark:caret-blue-400" /></label>
            <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-medium text-white disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />}{uiText("登录")}</button>
            <p className="text-center text-xs text-muted-foreground">{uiText("使用管理员分配的账号，画板保存在本机。")}</p>
          </form> : <button type="button" onClick={() => void login()} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />}{expires ? uiText("请在浏览器中完成钉钉授权") : uiText("使用钉钉登录")}</button>}
        </>}
    </section>
  </main>;
}
