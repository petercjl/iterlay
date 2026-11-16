import {Buffer} from 'node:buffer';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeInstallers, verifyInstaller} from '../scripts/desktop-release.mjs';
const hash='a'.repeat(64);
const url=`https://registry.npmjs.org/@petercjl/tuda-desktop/-/tuda-desktop-0.0.0-payload.${hash}.tgz`;
const windows={version:'0.1.5',platform:'win32',arch:'x64',sha256:hash,fileSize:20,downloadUrl:url,npmPayloads:[{sha256:hash,url,fileSize:20}]};
const mac={...windows,platform:'darwin',arch:'arm64'};
test('merging independently built releases preserves both platforms and rejects conflicting artifacts',()=>{
 const merged=mergeInstallers([mac],[windows],'0.1.5');
 assert.deepEqual(merged.map(x=>x.platform),['darwin','win32']);
 assert.deepEqual(mergeInstallers(merged,[mac],'0.1.5'),merged);
 assert.throws(()=>mergeInstallers([mac],[{...mac,sha256:'b'.repeat(64)}],'0.1.5'),/Conflicting/);
 for(const entry of [{...windows,version:'0.1.4'},{...windows,fileSize:21},{...windows,npmPayloads:[{sha256:hash,url:'https://invalid.test/file',fileSize:20}]}])assert.throws(()=>mergeInstallers([],[entry],'0.1.5'));
});
test('installer formats must match their declared platform',()=>{
 const exe=Buffer.alloc(1_000_000);exe.write('MZ');
 const dmg=Buffer.alloc(1_000_000);dmg.write('koly',dmg.length-512);
 verifyInstaller(exe,'win32');verifyInstaller(dmg,'darwin');
 assert.throws(()=>verifyInstaller(exe,'darwin'));
 assert.throws(()=>verifyInstaller(dmg,'win32'));
 assert.throws(()=>verifyInstaller(Buffer.from('MZ'),'win32'));
});
