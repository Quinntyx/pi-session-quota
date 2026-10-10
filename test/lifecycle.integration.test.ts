import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { test } from "node:test";
import { createExtension } from "../src/index.js";
import { QuotaWaiter } from "../src/waiter.js";

// Exercise the installed runtime, not a mocked ExtensionAPI. This is opt-in so
// ordinary package tests don't depend on a particular machine's Pi installation.
const sdkPath = process.env.PI_QUOTA_TEST_SDK;
// Optional cross-process coverage: Pi quota -> pi-sock -> Python timeout logic.
const sockExtension = process.env.PI_QUOTA_TEST_SOCK_EXTENSION;
const python = process.env.PI_QUOTA_TEST_PYTHON;
const pythonSource = process.env.PI_QUOTA_TEST_SUBAGENTS_SOURCE;
const crossProcess = Boolean(sockExtension && python && pythonSource);
const sockName = `quota-timeout-integration-${process.pid}`;
if (crossProcess) process.env.PI_SOCK_NAME = sockName;
function socketState(socketPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({id:"state",type:"get_state"})}\n`));
    socket.on("data", chunk => {
      data += chunk.toString();
      const line = data.split("\n")[0];
      if (!data.includes("\n")) return;
      const message = JSON.parse(line);
      socket.end();
      if (!message.success) reject(new Error(message.error)); else resolve(message.data);
    });
  });
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 12_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(10);
  }
}

for (const api of ["openai-completions", "openai-codex-responses"] as const) {
for (const outcome of ["resume", "weekly", "abort"] as const) {
  test(`real Pi lifecycle: ${api}: ${outcome}`, {skip: !sdkPath, timeout: 25_000}, async (t) => {
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
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const raw = Buffer.concat(parts);
      const body = (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString();
      requests.push({header:req.headers["x-cliproxyapi-session"] as string|undefined,body:JSON.parse(body)});
      if (available === 0 || weekly) {
        const code = weekly ? "weekly_quota_exhausted" : "provisioned_quota_exhausted";
        res.writeHead(429,{"content-type":"application/json","retry-after":"0",
          "x-cliproxyapi-quota-code":code,"x-cliproxyapi-quota-retry-after":"60","x-cliproxyapi-quota-required-points":"0.5"});
        res.end(JSON.stringify({error:{code,type:code,reason:"quota exceeded",message:weekly?"Weekly quota exhausted":"Out of provisioned quota",retry_after_seconds:60,required_points:0.5}}));
        return;
      }
      res.writeHead(200,{"content-type":"text/event-stream"});
      if (api === "openai-codex-responses") {
        const item = {type:"message",id:"msg-test",role:"assistant",content:[{type:"output_text",text:"completed",annotations:[]}],status:"completed"};
        const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        emit({type:"response.output_item.added",output_index:0,item:{...item,content:[],status:"in_progress"}});
        emit({type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
        emit({type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:"completed"});
        emit({type:"response.output_item.done",output_index:0,item});
        emit({type:"response.completed",response:{id:"resp-test",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
        res.end();
        return;
      }
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
    await writeFile(join(directory,"models.json"),JSON.stringify({providers:{cliproxyapi:{baseUrl,api,apiKey:api === "openai-codex-responses" ? `e30.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test"}})).toString("base64url")}.test` : "test",models:[{id:"quota-test",name:"Quota test",reasoning:false,input:["text"],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
    const waiter = new QuotaWaiter();
    const settingsManager = sdk.SettingsManager.inMemory({transport:"sse",retry:{enabled:false},compaction:{enabled:false},cacheWarming:{enabled:false}});
    const factories = [{factory:createExtension({resolveSession:async()=>"workflow",waiter}),source:"quota-test"}];
    if (crossProcess) factories.push({factory:(await import(pathToFileURL(sockExtension!).href)).default,source:"sock-test"});
    const loader = new sdk.DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,
      noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,disabledBuiltinExtensions:["mcp"],
      extensionFactories:factories});
    let session: any;
    let child: ChildProcess | undefined;
    let childDone: Promise<{code: number | null; stdout: string; stderr: string}> | undefined;
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
      const displayedErrors: string[] = [];
      session.subscribe((event:any)=>{
        if(event.type==="agent_settled") settled.push(event);
        if(event.type==="message_end" && event.message.role==="assistant" && event.message.stopReason==="error")
          displayedErrors.push(event.message.errorMessage);
      });
      t.signal.addEventListener("abort", () => { void session.abort(); }, {once:true});
      let resolved = false;
      const run = session.prompt("Do the workflow").then(()=>{resolved=true;});
      await eventually(()=>statusChecks>0,"quota wait begins");
      await delay(120);
      assert.equal(settled.length,0,"waiting must never settle");
      assert.equal(resolved,false,"parent Future must remain pending");
      assert.equal(session.isStreaming,true,"UI must retain an active run");
      assert.match(displayedErrors[0],/Reached provisioned quota cap, waiting for reset/,"the actual displayed failure must distinguish pending quota waits");
      assert.deepEqual(errors,[],"quota hooks must not throw");
      if (crossProcess) {
        const socketPath = join(homedir(),".pi","pi-sock",`${sockName}.sock`);
        const before = await socketState(socketPath);
        assert.equal(before.quotaWait.active,true,"real socket must report the quota pause");
        assert.equal(before.isIdle,false,"quota pause cannot be mistaken for an idle outcome");
        let childStdout = "";
        let childStderr = "";
        child = spawn(python!, [join(import.meta.dirname,"fixtures","quota-timeout-client.py"),socketPath,pythonSource!,api === "openai-codex-responses" ? "async" : "sync",outcome], {stdio:["ignore","pipe","pipe"]});
        child.stdout!.on("data", chunk => { childStdout += chunk.toString(); });
        child.stderr!.on("data", chunk => { childStderr += chunk.toString(); });
        childDone = new Promise((resolve,reject) => {
          child!.on("error",reject);
          child!.on("close",code=>resolve({code,stdout:childStdout,stderr:childStderr}));
        });
        await eventually(()=>childStdout.includes("CLIENT_STARTED"),"Python waiter starts");
        await delay(350); // Deliberately exceeds its 100ms execution allowance.
        assert.equal(child.exitCode,null,`parent waiter must remain pending: ${childStderr}`);
        assert.equal(child.signalCode,null);
        assert.equal(settled.length,0,"no settlement after the Python execution deadline");
        const during = await socketState(socketPath);
        assert.equal(during.quotaWait.active,true);
        assert.ok(during.quotaWait.elapsedMs > before.quotaWait.elapsedMs + 300);
      }
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
      if (childDone) {
        const result = await childDone;
        assert.equal(result.code,0,result.stderr);
        assert.match(result.stdout,/"settled"/);
        const after = await socketState(join(homedir(),".pi","pi-sock",`${sockName}.sock`));
        assert.equal(after.quotaWait.active,false,"terminal outcomes release the pause clock");
      }
      assert.deepEqual(errors,[]);
      if (outcome === "abort") {
        assert.equal(settled[0].aborted,true);
        assert.equal(requests.length,1);
      } else {
        assert.equal(requests.length,2,"retry must be a rebuilt request, not an opaque replay");
        assert.ok(JSON.stringify(requests[1].body.messages ?? requests[1].body.input).includes("Apply this steering before retrying"));
        assert.ok(!JSON.stringify(requests[1].body.messages ?? requests[1].body.input).includes("provisioned_quota_exhausted"));
        assert.equal(requests[0].header,"workflow");
        assert.equal(requests[1].header,"workflow");
        const last = session.messages.at(-1);
        assert.equal(last.stopReason,outcome === "weekly" ? "error" : "stop");
        if(outcome === "weekly") assert.match(last.errorMessage,api === "openai-codex-responses" ? /ChatGPT usage limit/ : /weekly_quota_exhausted/);
      }
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill();
      if (session?.isStreaming) await session.abort();
      if (crossProcess && session) await session.extensionRunner.emit({type:"session_shutdown"});
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      execFileSync("trash",[directory]);
    }
  });
}

}
