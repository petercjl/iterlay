import fs from "node:fs/promises";
import path from "node:path";
const version=process.argv[2];
if(!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version??""))throw Error("Provide an exact desktop version.");
const files=["package.json","desktop-package/package.json","desktop-package/release-manifest.json"];
const values=await Promise.all(files.map(async file=>{await fs.stat(file);return JSON.parse(await fs.readFile(file,"utf8"));}));
const backup=await fs.mkdtemp(path.resolve("tmp/desktop-version-"));
for(let i=0;i<files.length;i++){const file=files[i],value=values[i];await fs.copyFile(file,path.join(backup,i+".json"));if(i===2){value.applicationVersion=version;value.installers=[];}else{value.version=version;if(i===1)delete value.tudaRelease;}await fs.writeFile(file,JSON.stringify(value,null,2)+"\n");}
console.log(JSON.stringify({version,backup,pluginVersionUnchanged:true}));
