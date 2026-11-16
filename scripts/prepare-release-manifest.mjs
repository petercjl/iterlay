import {prepareDesktopRelease} from './desktop-release.mjs';
const arg=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
console.log(JSON.stringify(await prepareDesktopRelease({platform:arg('--platform')??'win32',arch:arg('--arch')??'x64',installer:arg('--installer'),mergeFile:arg('--merge')}),null,2));
