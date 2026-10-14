import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { createExtension } from "../../src/index.js";
import { QuotaWaiter } from "../../src/waiter.js";

export const sdkPath = process.env.PI_QUOTA_TEST_SDK;
export const apis = ["openai-completions", "openai-codex-responses"] as const;
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(10);
  }
}
export const rawContext = `RAW_CONTEXT ${"durable-history ".repeat(2_000)}`;
export type Request = { body: any; headers: Record<string, any>; wireBytes: number };
export function fail(res: ServerResponse, code: string, requiredPoints = 0.5, status = 429, message?: string) {
  const tooLarge = code === "context_too_large";
  const overflow = tooLarge || code === "context_length_exceeded";
  res.writeHead(status, {"content-type":"application/json", "retry-after":"0",
    ...(code === "provisioned_quota_exhausted" || code === "weekly_quota_exhausted" || tooLarge ? {
      "x-cliproxyapi-quota-code":tooLarge ? "request_too_large" : code,
      "x-cliproxyapi-quota-retry-after":"60", "x-cliproxyapi-quota-required-points":String(requiredPoints),
      ...(tooLarge ? {"x-cliproxyapi-quota-max-points":"100"} : {}),
    } : {}),
  });
  res.end(JSON.stringify({error:{code, type:overflow ? "invalid_request_error" : code,
    message:message ?? (tooLarge ? "Request exceeds the maximum provisioned admission size; reduce or compact the context"
      : overflow ? "Your input exceeds the context window of this model" : "quota exceeded"),
    reason:tooLarge ? "session quota request too large" : "quota exceeded", required_points:requiredPoints,
    ...(tooLarge ? {max_points:100,retryable:false} : {retry_after_seconds:60}),
  }}));
}
export function succeed(res: ServerResponse, api: typeof apis[number], text = "completed") {
  res.writeHead(200, {"content-type":"text/event-stream"});
  const emit = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (api === "openai-codex-responses") {
    const item = {type:"message", id:"msg-test", role:"assistant", content:[{type:"output_text",text,annotations:[]}],status:"completed"};
    emit({type:"response.output_item.added",output_index:0,item:{...item,content:[],status:"in_progress"}});
    emit({type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}});
    emit({type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:text});
    emit({type:"response.output_item.done",output_index:0,item});
    emit({type:"response.completed",response:{id:"resp-test",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  } else {
    const base = {id:"completion-test",object:"chat.completion.chunk",created:1,model:"quota-test"};
    emit({...base,choices:[{index:0,delta:{role:"assistant",content:text},finish_reason:null}]});
    emit({...base,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

/** Real installed SDK, real HTTP transports, and extension boundary/projection hooks. */
export async function lifecycle(api: typeof apis[number], options: {
  available?: number;
  held?: number;
  admissionReady?: boolean;
  inFlight?: number;
  debt?: number;
  cap?: number;
  smallWindow?: boolean;
  compact?: "cancel" | "provide" | "native";
  handle: (res: ServerResponse, index: number, request: Request) => void;
  statusFailure?: () => boolean;
}) {
  assert.ok(sdkPath, "PI_QUOTA_TEST_SDK must name the installed Pi 1.1.0 SDK");
  const version = JSON.parse(await readFile(join(dirname(sdkPath), "..", "package.json"), "utf8")).version;
  assert.equal(version, "1.1.0", "lifecycle evidence must use Pi 1.1.0");
  const sdk = await import(pathToFileURL(sdkPath).href);
  const directory = await mkdtemp(join(tmpdir(), "pi-session-quota-recovery-"));
  const waiter = new QuotaWaiter();
  const state = {available:options.available ?? 0,held:options.held ?? 0,cap:options.cap ?? 100,admissionReady:options.admissionReady,inFlight:options.inFlight ?? 0,debt:options.debt ?? 0,statusChecks:0,commands:0,resolved:false};
  const requests: Request[] = [];
  const settled: any[] = [];
  const compactions: any[] = [];
  const events: any[] = [];
  const errors: string[] = [];
  const pauses: Array<{active:boolean;reason:string}> = [];
  const notices: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  const workingMessages: Array<string | undefined> = [];
  let projectionCalls = 0;
  let session: any;
  const server = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/v1/session-quota") {
      state.statusChecks++;
      res.writeHead(options.statusFailure?.() ? 503 : 200, {"content-type":"application/json"});
      res.end(JSON.stringify({capacity:250,total_remaining:state.available + state.held,all_weekly_exhausted:false,retry_after_seconds:60,
        buckets:[{session:"workflow",cap:state.cap,remaining:state.available + state.held,held:state.held,available:state.available,admission_ready:state.admissionReady ?? state.available > 0,in_flight:state.inFlight,debt:state.debt},
          {session:"",cap:150,remaining:0,held:0,available:0}]}));
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts);
    if (req.method === "PUT" && req.url === "/v1/session-quota/sessions/workflow") {
      state.commands++;
      state.cap = JSON.parse(raw.toString()).cap;
      res.writeHead(200,{"content-type":"application/json"});
      res.end("{}");
      return;
    }
    const body = req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
    const request = {body:JSON.parse(body.toString()),headers:req.headers,wireBytes:body.length};
    requests.push(request);
    options.handle(res, requests.length, request);
  });
  // Native compaction calls use Codex's default auto transport. Reject the WS
  // handshake explicitly so its real client falls back to this local SSE server.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  try {
    await writeFile(join(directory,"models.json"), JSON.stringify({providers:{cliproxyapi:{baseUrl,api,
      apiKey:api === "openai-codex-responses" ? `e30.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"test"}})).toString("base64url")}.test` : "test",
      models:[{id:"quota-test",name:"Quota test",reasoning:false,input:["text"],contextWindow:options.smallWindow ? 2_048 : 100_000,maxTokens:100,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
    const settingsManager = sdk.SettingsManager.inMemory({transport:"sse",retry:{enabled:false},
      compaction:{enabled:true,reserveTokens:100,keepRecentTokens:100},cacheWarming:{enabled:false}});
    const monitor = (pi: any) => {
      pi.events.on("session-quota:wait-state", (event: any) => pauses.push(event));
      pi.on("context", (event: any) => {
        projectionCalls++;
        return {messages:event.messages.map((message:any) => message.role !== "user" ? message : {...message,
          content:typeof message.content === "string" ? message.content.replaceAll(rawContext,"PROJECTED_CONTEXT")
            : message.content.map((part:any) => part.type !== "text" ? part : {...part,text:part.text.replaceAll(rawContext,"PROJECTED_CONTEXT")}),
        })};
      });
      // BCP's wire transform contract returns the body itself, after context
      // projection. Every admission must use this latest sent view, not history.
      pi.on("before_provider_request", (event:any) => JSON.parse(JSON.stringify(event.payload)
        .replaceAll("PROJECTED_CONTEXT",`SENT_VIEW_${projectionCalls}`)));
      pi.on("session_before_compact", (event:any) => {
        if (!process.env.PI_QUOTA_TEST_BCP_EXTENSION) compactions.push(event);
        if (options.compact === "cancel") return {cancel:true};
        if (options.compact === "provide") return {compaction:{summary:"COMPACTED_SAFE_CONTEXT",
          firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore}};
      });
    };
    const bcpPath = process.env.PI_QUOTA_TEST_BCP_EXTENSION;
    const bcpFactories = bcpPath ? [{factory:(await import(pathToFileURL(bcpPath).href)).createAcpExtension({delegate:{enabled:false}}),source:"bcp-test"}] : [];
    const loader = new sdk.DefaultResourceLoader({cwd:directory,agentDir:directory,settingsManager,
      noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,disabledBuiltinExtensions:["mcp"],
      extensionFactories:[...bcpFactories,{factory:createExtension({resolveSession:async()=>"workflow",waiter}),source:"quota-test"},
        {factory:monitor,source:"projection-test"}]});
    await loader.reload();
    const runtime = await sdk.ModelRuntime.create({authPath:join(directory,"auth.json"),modelsPath:join(directory,"models.json")});
    const model = runtime.getModel("cliproxyapi","quota-test");
    assert.ok(model);
    ({session} = await sdk.createAgentSession({cwd:directory,agentDir:directory,modelRuntime:runtime,model,
      thinkingLevel:"off",settingsManager,resourceLoader:loader,sessionManager:sdk.SessionManager.inMemory(directory),noTools:"all"}));
    await session.bindExtensions({onError:(error:any)=>errors.push(String(error.message ?? error)),
      uiContext:{...session.extensionRunner.getUIContext(),
        notify:(message:string)=>notices.push(message),
        setWidget:(_key:string,value:string[]|undefined)=>widgets.push(value),
        setWorkingMessage:(value?:string)=>workingMessages.push(value),
      }});
    session.subscribe((event:any) => {
      events.push(event);
      // Earlier extensions may cancel the hook before our monitor executes.
      // Observe the real SDK event when testing the complete extension stack.
      if(bcpPath && event.type === "compaction_start") compactions.push({...event});
      if(bcpPath && (event.type === "compaction_end" || event.type === "auto_compaction_end") && compactions.length) {
        // Retry eligibility is emitted at the end, not on compaction_start.
        Object.assign(compactions[compactions.length-1], {willRetry:event.willRetry,aborted:event.aborted});
      }
      if(event.type === "agent_settled") settled.push(event);
    });
    return {session,state,waiter,requests,settled,compactions,events,errors,pauses,notices,widgets,workingMessages,
      get projectionCalls() {return projectionCalls;},
      start:() => session.prompt(`Finish with ${rawContext}`).then(()=>{state.resolved=true;}),
      async close() {
        if(session.isStreaming) await session.abort();
        session.dispose();
        server.closeAllConnections();
        await new Promise<void>(resolve=>server.close(()=>resolve()));
        execFileSync("trash",[directory]);
      }};
  } catch (error) {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    execFileSync("trash",[directory]);
    throw error;
  }
}
export function sentContext(request: Request): string {
  return JSON.stringify(request.body.messages ?? request.body.input);
}
export function assertProjected(request: Request, view: number) {
  assert.ok(sentContext(request).includes(`SENT_VIEW_${view}`), "latest context and wire projections must reach admission");
  assert.ok(!sentContext(request).includes("RAW_CONTEXT"), "raw durable history must never replace the sent view");
  assert.ok(!sentContext(request).includes("provisioned_quota_exhausted"), "failed assistant entries must not be replayed");
  assert.ok(!sentContext(request).includes("waiting for reset"));
  assert.equal(request.headers["x-cliproxyapi-session"],"workflow");
}
