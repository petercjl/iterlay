import { useUiText } from "@/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useEnterpriseStatus } from "./use-enterprise";
import { getImageWorkbenchApi, getWorkbenchErrorMessage } from "@/lib/image-workbench-api";
import logo from "@/assets/app-icon-default.png";
import omniLogo from "@/assets/omni-icon.png";

/** The workspace is mounted only after company verification and tool setup. */
export function CompanyLoginGate({ children }: { children: ReactNode }) {
  const uiText = useUiText();
  const status = useEnterpriseStatus();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [expires, setExpires] = useState(0);
  const [userCode, setUserCode] = useState("");
  const [surface, setSurface] = useState<"desktop" | "browser">("browser");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const omni = status?.accountProvider === "omni";
  const authorizationGeneration = useRef(0);
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
    const generation = authorizationGeneration.current;
    let active = true;
    let polling = false;
    const current = () => active && authorizationGeneration.current === generation;
    const timer = window.setInterval(() => {
      if (!current()) return;
      if (Date.now() >= expires) { setExpires(0); setBusy(false); setError(uiText("登录已超时，请重新登录。")); return; }
      if (polling) return;
      polling = true;
      void getImageWorkbenchApi().pollEnterpriseLogin().then(result => {
        if (current() && result.status === "authorized") { setExpires(0); setBusy(false); }
      }).catch(value => {
        if (current()) { setError(getWorkbenchErrorMessage(value)); setExpires(0); setBusy(false); }
      }).finally(() => { polling = false; });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [expires, uiText]);
  const login = async () => {
    authorizationGeneration.current++;
    setError(""); setBusy(true);
    try {
      const result = await getImageWorkbenchApi().beginEnterpriseLogin();
      setSurface(result.surface);
      setUserCode(result.userCode ?? "");
      setExpires(Date.parse(result.expiresAt));
    }
    catch (value) { setError(getWorkbenchErrorMessage(value)); setBusy(false); }
  };
  const openBrowser = async () => {
    const generation = authorizationGeneration.current;
    setError("");
    try {
      await getImageWorkbenchApi().openEnterpriseLoginInBrowser();
      if (authorizationGeneration.current === generation) setSurface("browser");
    } catch (value) {
      if (authorizationGeneration.current === generation) setError(getWorkbenchErrorMessage(value));
    }
  };
  const cancelAuthorization = async () => {
    setCancelling(true);
    try {
      if (!await getImageWorkbenchApi().cancelEnterpriseLogin()) return;
      authorizationGeneration.current++;
      setExpires(0);
      setUserCode("");
      setError("");
      setBusy(false);
    } catch (value) {
      setError(getWorkbenchErrorMessage(value));
    } finally {
      setCancelling(false);
    }
  };
  if (ready && status?.authenticated && status.accountMode === "shared") return <>{children}</>;
  return <main className="flex h-dvh items-center justify-center bg-background p-6 text-foreground" data-company-login-gate>
    <section className="w-full max-w-md rounded-3xl border border-border bg-card p-10 text-center text-card-foreground shadow-sm">
      <div className="mb-6 flex items-center justify-center gap-5">
        <img src={logo} alt="" className="size-14 rounded-xl" />
        <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
        <img src={omniLogo} alt="" className="size-14 rounded-xl" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{uiText("Tuda · 图塔")} <span className="mx-1 text-muted-foreground">×</span> {uiText("山海 OMNI")}</h1>
      <p className="mb-7 mt-3 text-sm text-muted-foreground">{uiText(status?.authenticated
        ? "正在准备你的工作区…" : "在山海 OMNI 中确认授权，即可登录 Tuda。")}</p>
      {error && <p role="alert" className="mb-5 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {!status ? <p className="text-sm text-muted-foreground">{uiText("正在连接公司账号服务…")}</p>
        : status.accountMode !== "shared" || !status.configured ? <p role="alert" className="text-sm text-destructive">{uiText("公司账号服务尚未配置，请联系管理员。")}</p>
        : status.authenticated ? <button type="button" onClick={() => setAttempt(value => value + 1)} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-medium text-white disabled:opacity-60">{busy && <Loader2 className="size-4 animate-spin" />}{busy ? uiText("正在验证登录并准备创作工具…") : uiText("重试连接")}</button>
        : <>
            <button type="button" onClick={() => void login()} disabled={busy || cancelling || !omni} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-60">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {uiText(expires ? (surface === "desktop" ? "请在山海 OMNI 中确认授权" : "请在浏览器中完成山海授权") : "前往山海授权登录")}
            </button>
            {!omni && <p role="status" className="mt-3 text-sm text-muted-foreground">{uiText("山海账号服务尚未配置，请联系管理员。")}</p>}
            {expires > 0 && userCode && <p role="status" className="mt-3 text-sm text-muted-foreground">{uiText("授权校验码 {{ui:0}}", [userCode])}</p>}
            {expires > 0 && <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm">
              <button type="button" disabled={cancelling} onClick={() => void cancelAuthorization()} className="font-medium text-foreground underline underline-offset-4 disabled:opacity-60">{uiText("取消授权")}</button>
              {surface === "desktop" && <button type="button" disabled={cancelling} onClick={() => void openBrowser()} className="text-muted-foreground underline underline-offset-4 disabled:opacity-60">{uiText("在浏览器中打开授权页")}</button>}
            </div>}
        </>}
    </section>
  </main>;
}
