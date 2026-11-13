import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { _electron as electron } from "playwright";
if (process.platform !== "win32" || !process.env.TUDA_E2E_ELECTRON || process.env.GITHUB_ACTIONS !== "true") throw Error("Verify the standalone installed release in an isolated Windows CI runner");
const root=process.cwd(), output=await mkdtemp(path.join(root,"output/playwright/tuda-smoke-update-"));
const env={...process.env,TUDA_PLAYWRIGHT:"1"};
delete env.TUDA_EMBEDDED_HOST; delete env.TUDA_USER_DATA_PATH;
let app;
try {
  app=await electron.launch({executablePath:process.env.TUDA_E2E_ELECTRON,args:[],cwd:root,env,timeout:60_000});
  const page=await app.firstWindow();
  await page.waitForURL(/dist\/index\.html/u,{timeout:60_000});
  await page.locator("#library-sidebar").waitFor();
  const version=await app.evaluate(({app})=>app.getVersion());
  const numbers=version.split(".").map(Number);numbers[2]++;
  const next=numbers.join("."), sha256="a".repeat(64);
  const url=`https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${sha256}.tgz`;
  const manifest={version:next,platform:"win32",arch:"x64",channel:"stable",downloadUrl:url,npmPayloads:[{url,sha256,fileSize:100}],sha256,fileSize:100};
  await app.evaluate(({net},manifest)=>{
    globalThis.tudaUpdateProbe={original:net.fetch.bind(net),mode:"error",calls:[],manifest};
    net.fetch=async(input,init)=>{
      const url=new URL(String(input)), probe=globalThis.tudaUpdateProbe;
      if (["registry.npmjs.org","registry.npmmirror.com"].includes(url.hostname)&&decodeURIComponent(url.pathname).endsWith("/tuda-desktop/latest")) {
        probe.calls.push(url.hostname);
        if(probe.mode==="error"||url.hostname==="registry.npmjs.org")throw new TypeError("Offline network fixture");
        return new globalThis.Response(JSON.stringify({version:probe.manifest.version,tudaRelease:{schemaVersion:1,applicationVersion:probe.manifest.version,installers:[probe.manifest]}}));
      }
      return probe.original(input,init);
    };
  },manifest);
  await page.locator("#library-sidebar").getByRole("button",{name:/检查更新|Check for updates/}).click();
  const dialog=page.getByRole("dialog").filter({hasText:/检查更新失败|Could not check for updates/});
  await dialog.getByText(/无法连接 npm 官方仓库及备用镜像|Cannot connect to the official npm registry/).waitFor();
  await dialog.getByText(/请检查网络或代理连接|Check your network or proxy connection/).waitFor();
  assert.equal(await dialog.getByRole("link",{name:/GitHub/}).count(),0);
  await page.screenshot({path:path.join(output,"update-network-error.png")});
  await page.keyboard.press("Escape");
  await app.evaluate(()=>{globalThis.tudaUpdateProbe.mode="mirror";globalThis.tudaUpdateProbe.calls=[];});
  const state=await page.evaluate(()=>window.imageWorkbench.checkForUpdates());
  assert.equal(state.phase,"available");assert.equal(state.manifest.version,next);
  const calls=await app.evaluate(()=>globalThis.tudaUpdateProbe.calls);
  assert.equal(calls[0],"registry.npmjs.org");assert(calls.includes("registry.npmmirror.com"));
  console.log(JSON.stringify({ok:true,version,installedElectronFetch:true,officialFailureFallback:true,errorDialogActionable:true,mirrorManifestValidated:true,screenshot:path.join(output,"update-network-error.png")},null,2));
} catch (error) {
  await app?.firstWindow().then(page=>page.screenshot({path:path.join(output,"update-network-failure.png")})).catch(()=>{});
  throw error;
} finally {
  await app?.evaluate(({net})=>{if(globalThis.tudaUpdateProbe)net.fetch=globalThis.tudaUpdateProbe.original;}).catch(()=>{});
  await app?.close();
}
