import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createExtension } from "../src/index.js";
import { QuotaWaiter } from "../src/waiter.js";

// Exercise the installed runtime, not a mocked ExtensionAPI. This is opt-in so
// ordinary package tests don't depend on a particular machine's Pi installation.
const sdkPath = process.env.PI_QUOTA_TEST_SDK;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 12_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(10);
  }
}

for (const outcome of ["resume", "weekly", "abort"] as const) {
  test(`real Pi lifecycle: ${outcome}`, {skip: !sdkPath, timeout: 25_000}, async (t) => {
    const sdk = await import(pathToFileURL(sdkPath!).href);
    const directory = await mkdtemp(join(tmpdir(), "pi-session-quota-lifecycle-"));
    let available = 0;
    let weekly = false;
    let statusChecks = 0;
    const requests: Array<{header: string | undefined; body: any}> = [];
    const server = createServer(async (req, res) => {
      if (req.url === "/v1/session-quota") {
        statusChecks++;
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({capacity:250,total_remaining:available,all_weekly_exhausted:weekly,retry_after_seconds:60,
          buckets:[{session:"workflow",cap:100,remaining:available,held:0,available},
            {session:"",cap:150,remaining:0,held:0,available:0}]}));
        return;
      }
      let body = "";
      for await (const part of req) body += part;
      requests.push({header:req.headers["x-cliproxyapi-session"] as string|undefined,body:JSON.parse(body)});
      if (available === 0 || weekly) {
        const code = weekly ? "weekly_quota_exhausted" : "provisioned_quota_exhausted";
        res.writeHead(429,{"content-type":"application/json","retry-after":"0"});
        res.end(JSON.stringify({error:{code,type:code,message:weekly?"Weekly quota exhausted":"Out of provisioned quota",retry_after_seconds:60,required_points:0.5}}));
        return;
      }
      res.writeHead(200,{"content-type":"text/event-stream"});
      const base = {id:"completion-test",object:"chat.completion.chunk",created:1,model:"quota-test"};
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:"assistant",content:"completed"},finish_reason:null}]})}

`);
      res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}

`);
      res.end(`data: [DONE]

`);
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    const address = server.address() as {port:number};
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(join(directory,"models.json"),JSON.stringify({providers:{cliproxyapi:{baseUrl,api:"openai-completions",apiKey:"test",models:[{id:"quota-test",name:"Quota test",reasoning:false,input:["text"],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
    const waiter = new QuotaWaiter();
    const settingsManager = sdk.SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:{enabled:false}});
    const loader = new sdk.DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,
      noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,disabledBuiltinExtensions:["mcp"],
      extensionFactories:[{factory:createExtension({resolveSession:async()=>"workflow",waiter}),source:"quota-test"}]});
    let session: any;
    try {
      await loader.reload();
      const runtime = await sdk.ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:join(directory,"models.json")});
      const model = runtime.getModel("cliproxyapi","quota-test");
      assert.ok(model,"fixture model must be available");
      ({session} = await sdk.createAgentSession({cwd:directory,agentDir:directory,modelRuntime:runtime,model,
        thinkingLevel:"off",settingsManager,resourceLoader:loader,sessionManager:sdk.SessionManager.inMemory(directory),noTools:"all"}));
      const errors: string[] = [];
      session.bindExtensions({onError:(error:any)=>errors.push(String(error.message ?? error))});
      const settled: any[] = [];
      session.subscribe((event:any)=>{if(event.type==="agent_settled") settled.push(event);});
      t.signal.addEventListener("abort", () => { void session.abort(); }, {once:true});
      let resolved = false;
      const run = session.prompt("Do the workflow").then(()=>{resolved=true;});
      await eventually(()=>statusChecks>0,"quota wait begins");
      await delay(120);
      assert.equal(settled.length,0,"waiting must never settle");
      assert.equal(resolved,false,"parent Future must remain pending");
      assert.equal(session.isStreaming,true,"UI must retain an active run");
      assert.deepEqual(errors,[],"quota hooks must not throw");
      if (outcome === "abort") {
        await session.abort();
      } else {
        await session.steer("Apply this steering before retrying");
        if (outcome === "weekly") weekly = true;
        else available = 1;
        waiter.wake();
      }
      await run;
      await eventually(()=>settled.length===1,"one terminal settlement");
      assert.deepEqual(errors,[]);
      if (outcome === "abort") {
        assert.equal(settled[0].aborted,true);
        assert.equal(requests.length,1);
      } else {
        assert.equal(requests.length,2,"retry must be a rebuilt request, not an opaque replay");
        assert.ok(JSON.stringify(requests[1].body.messages).includes("Apply this steering before retrying"));
        assert.ok(!JSON.stringify(requests[1].body.messages).includes("provisioned_quota_exhausted"));
        assert.equal(requests[0].header,"workflow");
        assert.equal(requests[1].header,"workflow");
        const last = session.messages.at(-1);
        assert.equal(last.stopReason,outcome === "weekly" ? "error" : "stop");
        if(outcome === "weekly") assert.match(last.errorMessage,/weekly_quota_exhausted/);
      }
    } finally {
      if (session?.isStreaming) await session.abort();
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      execFileSync("trash",[directory]);
    }
  });
}
