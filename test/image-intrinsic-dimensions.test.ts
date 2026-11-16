// @vitest-environment jsdom
import {act, createElement, useState} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {useImageDimensions} from "../src/features/boards/use-image-dimensions";
import type {GeneratedImage} from "../src/components/canvas/image-node-model";
import {projectCanvasNodes} from "../src/components/canvas/canvas-node-projection";
import {serializeGeneratedImage} from "../src/lib/board-node-image";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
it("repairs missing and stale intrinsic dimensions without changing positions or display width",async()=>{
 const read=vi.fn(async()=>({width:900,height:1200}));
 let images:GeneratedImage[]=[];
 function View(){const [value,setValue]=useState<GeneratedImage[]>([{id:"portrait",path:"asset:portrait",dataUrl:"asset://portrait",jobId:"",width:1024,height:1024}]);images=value;useImageDimensions(value,setValue,read);return null;}
 const container=document.createElement("div"),root=createRoot(container);
 try{
  await act(async()=>root.render(createElement(View)));
  expect(images[0]).toMatchObject({width:900,height:1200});expect(read).toHaveBeenCalledOnce();
  const projected=projectCanvasNodes({images,previousNodes:[],workflowNodes:[],edges:[],initialLayouts:{portrait:{x:100,y:200,width:264}},bindings:{imageData:()=>({onCopy:()=>{},onUseReference:()=>{},onSave:()=>{}}),textData:()=>({text:"",onChange:()=>{}}),generationData:()=>({prompt:"",model:"",size:"auto",count:1,onChange:()=>{}})}});
  expect(projected.nodes[0]).toMatchObject({position:{x:100,y:200},width:264,height:352});
  expect(serializeGeneratedImage(images[0],{x:100,y:200,width:264})).toMatchObject({width:900,height:1200,displayWidth:264,x:100,y:200});
 }finally{await act(async()=>root.unmount());}
});
it("ignores a late size result after switching the image version",async()=>{
 let resolveOld!:(size:{width:number;height:number})=>void;
 const old=new Promise<{width:number;height:number}>(resolve=>{resolveOld=resolve;});
 const read=vi.fn((url:string)=>url==="old"?old:Promise.resolve({width:1600,height:900}));
 let replace!:(value:GeneratedImage[])=>void,images:GeneratedImage[]=[];
 function View(){const [value,setValue]=useState<GeneratedImage[]>([{id:"image",path:"old",dataUrl:"old",jobId:""}]);images=value;replace=setValue;useImageDimensions(value,setValue,read);return null;}
 const root=createRoot(document.createElement("div"));
 try{
  await act(async()=>root.render(createElement(View)));
  await act(async()=>replace([{id:"image",path:"new",dataUrl:"new",jobId:""}]));
  await act(async()=>resolveOld({width:900,height:1200}));
  expect(images[0]).toMatchObject({path:"new",width:1600,height:900});
 }finally{await act(async()=>root.unmount());}
});
