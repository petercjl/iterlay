import type { ResolvedAppLocale } from "../shared/i18n.js";

export interface StartupPageOptions {
  dark: boolean;
  locale?: ResolvedAppLocale;
}

export function buildStartupPage({ dark, locale = "zh-CN" }: StartupPageOptions): string {
  const background = dark ? "#121212" : "#fafafa";
  const foreground = dark ? "#f2f2f2" : "#171717";
  const shadow = dark ? "rgb(0 0 0 / 25%)" : "rgb(35 55 106 / 10%)";
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tuda</title><style>
:root{color-scheme:${dark ? "dark" : "light"};font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
html,body{min-height:100%;margin:0;overflow:hidden;background:${background};color:${foreground}}
*{box-sizing:border-box}.boot{display:flex;min-height:100vh;flex-direction:column;align-items:center;justify-content:center;gap:20px;isolation:isolate;-webkit-app-region:drag}
.mark{position:relative;width:96px;height:86px;contain:layout paint style}.mark svg,.layer{position:absolute;inset:0;width:100%;height:100%}
.layer{display:block;opacity:0;transform-origin:center;backface-visibility:hidden;will-change:transform,opacity;animation:settle 1.5s cubic-bezier(.22,1,.36,1) infinite both}
.shadow{fill:${shadow}}.top{--fx:15px;--fy:-16px;--tx:-4px;--ty:4px}.middle{--fx:20px;--fy:2px;--tx:-5px;--ty:-1px;animation-delay:.08s}.bottom{--fx:-16px;--fy:15px;--tx:4px;--ty:-4px;animation-delay:.16s}
.face{fill:#2f61e8;stroke:rgb(39 79 176 / 32%);stroke-width:.75}.edge{fill:#16368f}strong{font-size:18px;font-weight:600;line-height:1}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
@keyframes settle{0%{opacity:0;transform:translate3d(var(--fx),var(--fy),0) scale(.94)}24%,70%{opacity:1;transform:translate3d(0,0,0) scale(1)}86%,100%{opacity:0;transform:translate3d(var(--tx),var(--ty),0) scale(.985)}}
@media(prefers-reduced-motion:reduce){.layer{animation:none;opacity:1}}
</style></head><body><main class="boot" role="status" aria-live="polite">
<div class="mark" role="img" aria-label="Tuda"><svg viewBox="0 0 1024 1024" aria-hidden="true">
  <title>Tuda · 图塔</title>
  <rect x="64" y="64" width="896" height="896" rx="184" fill="#fff"/>
  <path d="M280 250H747C801 250 838 288 838 343V374H633C600 374 571 382 544 399L414 480V454H280C223 454 184 415 184 357V347C184 290 223 250 280 250Z" fill="#0755F5"/>
  <path d="M414 538C414 513 423 498 444 484L572 406C592 394 610 392 632 392V757C632 814 593 850 537 850H510C452 850 414 812 414 757Z" fill="#00C8AE"/>
</svg></div>
<strong>Tuda</strong><span class="sr">${locale === "zh-CN" ? "正在打开 Tuda" : "Opening Tuda"}</span></main></body></html>`;
}
