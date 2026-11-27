import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {c} from "tar";
export const payloadLimit=48*1024*1024;
export function verifyInstaller(bytes,platform){
 if(bytes.length<1_000_000)throw Error("A real installer is required.");
 if(platform==="win32"&&bytes.toString("ascii",0,2)==="MZ")return;
 if(platform==="darwin"&&bytes.toString("ascii",bytes.length-512,bytes.length-508)==="koly")return;
 throw Error("Installer format does not match its platform.");
}
export function mergeInstallers(current,incoming,version){
 const result=new Map();
 for(const item of [...current,...incoming]){
  if(item.version!==version||!["win32","darwin"].includes(item.platform)||!["x64","arm64"].includes(item.arch)||! /^[a-f0-9]{64}$/.test(item.sha256)||!Array.isArray(item.npmPayloads)||!item.npmPayloads.length)throw Error("Invalid platform release.");
  let size=0;for(const part of item.npmPayloads){if(!/^[a-f0-9]{64}$/.test(part.sha256)||!Number.isSafeInteger(part.fileSize)||part.fileSize<=0||part.fileSize>payloadLimit||part.url!==`https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${part.sha256}.tgz`)throw Error("Invalid payload binding.");size+=part.fileSize;}
  if(size!==item.fileSize||item.downloadUrl!==item.npmPayloads[0].url)throw Error("Invalid installer size or URL.");
  const key=`${item.platform}/${item.arch}`,previous=result.get(key);if(previous&&previous.sha256!==item.sha256)throw Error("Conflicting artifact for "+key);result.set(key,previous??item);
 }
 return [...result.values()].sort((a,b)=>`${a.platform}/${a.arch}`.localeCompare(`${b.platform}/${b.arch}`));
}
export async function prepareDesktopRelease({root=process.cwd(),platform="win32",arch="x64",installer,mergeFile}){
 if(!["win32","darwin"].includes(platform)||!["x64","arm64"].includes(arch))throw Error("Unsupported target.");
 const pkgPath=path.join(root,"desktop-package/package.json"),manifestPath=path.join(root,"desktop-package/release-manifest.json");
 const pkg=JSON.parse(await fs.readFile(pkgPath,"utf8")),app=JSON.parse(await fs.readFile(path.join(root,"package.json"),"utf8")),existing=JSON.parse(await fs.readFile(manifestPath,"utf8"));
 if(pkg.name!=="@petercjl/tuda-desktop"||pkg.version!==app.version||existing.applicationVersion!==app.version)throw Error("Desktop release identity mismatch.");
 let incoming=[],payloadRoot;
 if(mergeFile){const other=JSON.parse(await fs.readFile(mergeFile,"utf8"));if(other.schemaVersion!==1||other.applicationVersion!==app.version)throw Error("Merged release version mismatch.");incoming=other.installers;}
 else{
  const file=installer??path.join(root,`release/Tuda-${app.version}-${arch}.${platform==="win32"?"exe":"dmg"}`),bytes=await fs.readFile(file);verifyInstaller(bytes,platform);
  const prepared=await prepareDesktopPayloads(bytes,root,pkg);
  payloadRoot=prepared.payloadRoot;const {parts}=prepared;
  incoming=[{version:app.version,platform,arch,channel:app.version.includes("-")?"beta":"stable",downloadUrl:parts[0].url,npmPayloads:parts,sha256:createHash("sha256").update(bytes).digest("hex"),fileSize:bytes.length,publishedAt:new Date().toISOString(),releaseNotes:`Tuda · 图塔 ${app.version}`}];
 }
 const release={schemaVersion:1,applicationVersion:app.version,installers:mergeInstallers(existing.installers,incoming,app.version)};
 await fs.mkdir(path.join(root,"tmp"),{recursive:true});const backup=await fs.mkdtemp(path.join(root,"tmp/release-metadata-"));
 for(const [file,value]of [[pkgPath,{...pkg,tudaRelease:release}],[manifestPath,release]]){await fs.stat(file);await fs.copyFile(file,path.join(backup,path.basename(file)));await fs.writeFile(file,JSON.stringify(value,null,2)+"\n");}
 return {ok:true,version:app.version,payloadRoot,targets:release.installers.map(item=>`${item.platform}/${item.arch}`),backup};
}

export async function prepareDesktopPayloads(bytes,root,pkg){
  const payloadRoot=await fs.mkdtemp(path.join(root,"release/npm-payloads-"));const parts=[];
  for(let offset=0;offset<bytes.length;offset+=payloadLimit){
   const block=bytes.subarray(offset,offset+payloadLimit),sha256=createHash("sha256").update(block).digest("hex"),version=`0.0.0-payload.${sha256}`,directory=path.join(payloadRoot,sha256,"package");await fs.mkdir(directory,{recursive:true});
   await fs.writeFile(path.join(directory,"payload.bin"),block,{flag:"wx"});
   await fs.writeFile(path.join(directory,"package.json"),JSON.stringify({name:pkg.name,version,description:"Immutable Tuda installer payload. Install the desktop release, not this internal data version.",license:"MIT",repository:pkg.repository,files:["payload.bin"],scripts:{check:"node validate.mjs",prepack:"node validate.mjs"},publishConfig:{access:"public"}})+"\n",{flag:"wx"});
   await fs.writeFile(path.join(directory,"validate.mjs"),`import fs from 'node:fs';import {createHash} from 'node:crypto';const b=fs.readFileSync(new URL('payload.bin',import.meta.url));if(b.length!==${block.length}||createHash('sha256').update(b).digest('hex')!==${JSON.stringify(sha256)})throw Error('Payload integrity mismatch');\n`,{flag:"wx"});
   await fs.writeFile(path.join(directory,".npm-release-kit.json"),JSON.stringify({schemaVersion:1,mode:"local",checks:[["run","check"]]})+"\n",{flag:"wx"});
   await c({gzip:true,portable:true,noMtime:true,cwd:path.dirname(directory),file:path.join(payloadRoot,`tuda-${version}.tgz`)},["package"]);
   parts.push({url:`https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-${version}.tgz`,sha256,fileSize:block.length});
  }
  return {payloadRoot,parts};
}
