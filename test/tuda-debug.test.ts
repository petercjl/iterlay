import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { TudaDebugAgent } from "../electron/debug-agent.js";
import { installModelNetworkAudit, readModelNetworkEvidence, withModelTrace } from "../electron/debug-network.js";
import { inExecutionContext } from "../electron/execution-space.js";
import type { CreationSession } from "../shared/creation-session.js";
import type { CollaborateSceneStreamEvent } from "../shared/types.js";

describe("Tuda debug shared harness adapter", () => {
  function fixture() {
    const sessions: CreationSession[] = []; let receive: (e: CollaborateSceneStreamEvent) => void = () => undefined; let starts = 0;
    const agent = new TudaDebugAgent({ invoke: async (channel,args) => {
      if (channel === "creation:sessions:list") return structuredClone(sessions);
      if (channel === "assistant:history:list") return [];
      const session = structuredClone(args[0]) as CreationSession;
      const index=sessions.findIndex(s=>s.id===session.id); if(index>=0)sessions[index]=session;else sessions.push(session);
    }, start: (_id,req,next) => {expect(req.creationWorkflow).toBe(true);expect(req.agentMode).toBe(true);starts++;receive=next;},
    cancel: id => receive({requestId:id,type:"cancelled"}), respond: () => undefined });
    return { agent, emit: (e: CollaborateSceneStreamEvent)=>receive(e), starts:()=>starts };
  }
  it("persists UI-compatible messages, tools, public activity and result; deduplicates a request", async () => {
    const f=fixture(); const session=await f.agent.call("debug_chats_create",{name:"test"}) as CreationSession;
    const args={conversationId:session.id,prompt:"read only",requestId:"once"};
    await Promise.all([f.agent.call("debug_chats_send",args),f.agent.call("debug_chats_send",args)]);expect(f.starts()).toBe(1);
    await expect(f.agent.call("debug_chats_send",{...args,prompt:"different"})).rejects.toThrow("不同内容");
    f.emit({requestId:"once",type:"tool",tool:{id:"tool1",name:"list_boards",status:"completed",output:JSON.stringify({count:3})}});
    f.emit({requestId:"once",type:"delta",delta:"answer"});
    f.emit({requestId:"once",type:"result",result:{message:"final",fields:[]}});
    const saved=await f.agent.call("debug_chats_get",{conversationId:session.id}) as CreationSession;
    expect(saved.messages.map(m=>m.content)).toEqual(["read only","final"]);expect(saved.activeRunId).toBeUndefined();
    expect(saved.messages[1].toolCalls?.[0].name).toBe("list_boards");
    expect(await f.agent.call("debug_chats_result",{conversationId:session.id})).toMatchObject({status:"completed"});
  });
  it("waits for explicit interaction and supports cancellation",async()=>{
    const f=fixture();const s=await f.agent.call("debug_chats_create",{}) as CreationSession;
    await f.agent.call("debug_chats_send",{conversationId:s.id,prompt:"test",requestId:"waiting"});
    f.emit({requestId:"waiting",type:"interaction",interactionId:"confirm",interaction:{type:"confirm",title:"Confirm"}});
    expect(await f.agent.call("debug_chats_result",{conversationId:s.id})).toMatchObject({status:"waiting"});
    await expect(f.agent.call("debug_chats_respond",{conversationId:s.id,interactionId:"wrong",action:"submit"})).rejects.toThrow();
    await f.agent.call("debug_chats_cancel",{conversationId:s.id});
    expect(await f.agent.call("debug_chats_result",{conversationId:s.id})).toMatchObject({status:"cancelled"});
  });
  it("captures actual HTTP address/status and excludes secrets, bodies, queries and other account scopes",async()=>{
    installModelNetworkAudit();
    const server=createServer((_req,res)=>res.end("private-response"));
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();if(!address||typeof address==="string")throw new Error("port");
    try {
      await inExecutionContext({account:"one",space:"personal"},()=>withModelTrace({model:true,conversationId:"wire-test",requestId:"wire"},async()=>{
        const response=await fetch(`http://127.0.0.1:${address.port}/model?key=private-query`,{method:"POST",headers:{authorization:"Bearer private-key"},body:"private-prompt"}); await response.text();
        const rows=readModelNetworkEvidence("wire-test");expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({method:"POST",path:"/model",status:200,remoteAddress:"127.0.0.1",state:"completed"});
        expect(JSON.stringify(rows)).not.toMatch(/private-/);
      }));
      expect(inExecutionContext({account:"two",space:"personal"},()=>readModelNetworkEvidence("wire-test"))).toEqual([]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  });
});
