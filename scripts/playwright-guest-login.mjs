import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";

const root=path.resolve(import.meta.dirname,"..");
if(!process.env.TUDA_GUEST_TEST_CREDENTIAL_FILE||!process.env.TUDA_COMPANY_URL)throw Error("Provide a private credential file and account origin.");
const credentials=JSON.parse(await fs.readFile(process.env.TUDA_GUEST_TEST_CREDENTIAL_FILE,"utf8"));
const directory=await fs.mkdtemp(path.join(root,"tmp/guest-login-e2e-"));
await fs.chmod(directory,0o700);
const userData=path.join(directory,"user-data");
const env={...process.env,TUDA_PLAYWRIGHT:"1",TUDA_E2E_USER_DATA:userData,VITE_DEV_SERVER_URL:"http://127.0.0.1:5180"};
delete env.ELECTRON_RUN_AS_NODE;delete env.TUDA_EMBEDDED_HOST;delete env.TUDA_USER_DATA_PATH;
const packaged=process.env.TUDA_E2E_PACKAGED === "1";
if(packaged)delete env.VITE_DEV_SERVER_URL;
const launch=()=>electron.launch({executablePath:process.env.TUDA_E2E_ELECTRON??path.join(root,"tmp/desktop-runtime/current/Tuda.app/Contents/MacOS/Electron"),args:packaged?[]:["."],cwd:root,env,timeout:60000});
let app;
try{
 app=await launch();let page=await app.firstWindow();
 await page.getByRole("button",{name:"使用钉钉登录",exact:true}).waitFor({timeout:60000});
 await page.getByRole("button",{name:"账号密码登录",exact:true}).click();
 await page.getByLabel("账号",{exact:true}).fill(credentials.username);
 await page.getByLabel("密码",{exact:true}).fill(credentials.password);
 await page.getByRole("button",{name:"登录",exact:true}).click();
 await page.locator("[data-global-account]").waitFor({timeout:90000});
 const status=await page.evaluate(()=>window.imageWorkbench.enterpriseStatus());
 assert.equal(status.accountKind,"password");assert.equal(status.activeSpace,"personal");assert.equal(status.storageKind,"local");assert.equal(status.user.name,credentials.username);
 const boards=await page.evaluate(()=>window.imageWorkbench.listBoards());
 const guestRoots=await fs.readdir(path.join(userData,"guest-workspaces"));assert.equal(guestRoots.length,1);
 for(const board of boards){const saved=JSON.parse(await fs.readFile(path.join(userData,"guest-workspaces",guestRoots[0],"boards",board.id+".json"),"utf8"));assert.equal(saved.nodes.length,0);}
 assert.equal(await page.getByRole("button",{name:"切换本地与企业空间",exact:true}).count(),0);
 await page.getByText("本地空间",{exact:true}).waitFor();
 const board=await page.evaluate(()=>window.imageWorkbench.createBoard("Release persistence verification"));
 let embeddedCli=false,piRuntime=false;
 if(packaged){
  const runtime=await app.evaluate(({app})=>({executable:process.execPath,resources:process.resourcesPath,appPath:app.getAppPath(),packaged:app.isPackaged,version:app.getVersion()}));
  assert.equal(runtime.packaged,true);assert.equal(runtime.version,JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8")).version);
  const probeEnv={...env,ELECTRON_RUN_AS_NODE:"1",TUDA_NO_UPDATE_CHECK:"1"};
  const pi=spawnSync(runtime.executable,["--input-type=module","-e",`const r=await import(${JSON.stringify(pathToFileURL(path.join(runtime.appPath,"dist-electron/electron/agents/coding-runtime.js")).href)});if(typeof r.createAgentSession!=="function"||typeof r.ModelRuntime.create!=="function")throw Error("Pi unavailable");`],{env:probeEnv,encoding:"utf8",timeout:30000});
  assert.equal(pi.status,0,pi.stderr);piRuntime=true;
  const cli=spawnSync(runtime.executable,[path.join(runtime.resources,"cli/dist/main.js"),"boards","list","--user-data-path",userData,"--no-launch","--json"],{env:probeEnv,encoding:"utf8",timeout:30000});
  assert.equal(cli.status,0,cli.stderr);const reply=JSON.parse(cli.stdout);assert.equal(reply.ok,true);assert(reply.data.some(item=>item.id===board.id));embeddedCli=true;
 }
 await page.screenshot({path:path.join(directory,"guest-home.png")});
 await app.close();
 if(process.env.TUDA_E2E_REINSTALLER){
  assert.equal(process.platform,"win32");
  const target=path.dirname(process.env.TUDA_E2E_ELECTRON);
  assert(target.startsWith(path.join(root,"tmp")+path.sep),"Installer QA requires an isolated install directory");
  const install=spawnSync(process.env.TUDA_E2E_REINSTALLER,["/S",`/D=${target}`],{encoding:"utf8",timeout:120000});
  assert.equal(install.status,0,install.stderr);
 }
 app=await launch();page=await app.firstWindow();
 await page.locator("[data-global-account]").waitFor({timeout:90000});
 assert((await page.evaluate(()=>window.imageWorkbench.listBoards())).some(item=>item.id===board.id),"Saved board survives a process restart");
 const restored=await page.evaluate(()=>window.imageWorkbench.enterpriseStatus());assert.equal(restored.user.name,credentials.username);assert.equal(restored.accountKind,"password");
 await page.evaluate(()=>window.imageWorkbench.enterpriseLogout());
 await page.getByRole("button",{name:"使用钉钉登录",exact:true}).waitFor({timeout:30000});
 for(let cycle=0;cycle<2;cycle++){
  await page.getByRole("button",{name:"账号密码登录",exact:true}).click();
  await page.getByLabel("账号",{exact:true}).fill(credentials.username);
  await page.getByLabel("密码",{exact:true}).fill(credentials.password);
  await page.getByRole("button",{name:"登录",exact:true}).click();
  await page.locator("[data-global-account]").waitFor({timeout:60000});
  assert.equal((await page.evaluate(()=>window.imageWorkbench.enterpriseStatus())).user.name,credentials.username);
  await page.evaluate(()=>window.imageWorkbench.enterpriseLogout());
  await page.getByRole("button",{name:"使用钉钉登录",exact:true}).waitFor({timeout:30000});
 }
 const receipt={login:true,sessionRestored:true,localIsolation:true,boardSavedAcrossRestart:true,nasHidden:true,loggedOut:true,loginLogoutCycles:3,reinstalled:!!process.env.TUDA_E2E_REINSTALLER,embeddedCli,piRuntime,packaged,version:await app.evaluate(({app})=>app.getVersion()),platform:process.platform,imageModels:status.imageModels,textModels:status.textModels};
 await fs.writeFile(path.join(directory,"receipt.json"),JSON.stringify(receipt,null,2),{flag:"wx",mode:0o600});
 console.log(JSON.stringify({directory,...receipt}));
}finally{await app?.close();}
