import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Generated bundles are rebuilt on each target; their source inputs are included.
const root=path.resolve(import.meta.dirname,'..');
const entries=[];
async function walk(relative){
 const info=await fs.stat(path.join(root,relative));
 if(info.isDirectory()){
  for(const name of (await fs.readdir(path.join(root,relative))).sort()){
   if(['node_modules','dist','.cache'].includes(name))continue;
   await walk(`${relative}/${name}`);
  }
 }else entries.push([relative,createHash('sha256').update(await fs.readFile(path.join(root,relative))).digest('hex')]);
}
for(const dir of ['electron','shared','src','plugins','packages','demo-assets','resources/app-icons','resources/skills','native','build']){
 if(await fs.stat(path.join(root,dir)).then(()=>true,()=>false))await walk(dir);
}
for(const file of ['package.json','pnpm-lock.yaml','cli/package.json','cli/package-lock.json','index.html','vite.config.ts','tailwind.config.ts','tsconfig.json','scripts/build-native.mjs','scripts/build-plugins.mjs','scripts/build-preload.mjs','scripts/build-code-sandbox.mjs','scripts/release-mac.mjs','scripts/release-windows.mjs','scripts/prepare-company-defaults.mjs']){
 if(await fs.stat(path.join(root,file)).then(()=>true,()=>false))await walk(file);
}
await walk('cli/src');
entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
console.log(JSON.stringify({schemaVersion:1,version:JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version,sha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex'),files:entries.length}));
