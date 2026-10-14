import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuotaClient } from "../src/quota-client.js";
import { QuotaWaiter } from "../src/waiter.js";

function ctx(signal: AbortSignal, widgets: Array<string[] | undefined> = []): ExtensionContext {
  return { signal, ui: {setStatus() {}, setWidget(_key: string, value: string[] | undefined) {widgets.push(value);}, setWorkingMessage() {}} } as unknown as ExtensionContext;
}
function fixture(available = 0) {
  const state = {available, ready: undefined as boolean | undefined, debt: 0, inFlight: 0, weekly: false};
  const client = new QuotaClient({endpoint:"http://proxy/v1/session-quota",headers:{}}, async () =>
    new Response(JSON.stringify({capacity:250,total_remaining:available,all_weekly_exhausted:state.weekly,retry_after_seconds:3600,
      buckets:[{session:"work",cap:100,remaining:state.available,held:0,available:state.available,
        debt:state.debt,in_flight:state.inFlight,admission_ready:state.ready}]})));
  return {state,client,waiter:new QuotaWaiter(),controller:new AbortController()};
}
const tick = () => new Promise(resolve => setTimeout(resolve,10));

test("zero credit remains pending until fresh status is ready",async () => {
  const f=fixture(); let resolved=false;
  const pending=f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal),3600).then(r=>{resolved=true;return r;});
  try {await tick(); assert.equal(resolved,false); f.state.available=0.000001; f.waiter.wake(); assert.equal(await pending,"retry");}
  finally {f.controller.abort();}
});
test("Escape cancels waiting and clears its widget",async () => {
  const f=fixture();const widgets:Array<string[]|undefined>=[];
  const pending=f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal,widgets));
  await tick();f.controller.abort();assert.equal(await pending,"aborted");assert.equal(widgets.at(-1),undefined);
});
test("any tiny positive credit admits, including interactive fallback",async () => {
  const client=new QuotaClient({endpoint:"http://proxy/v1/session-quota",headers:{}},async()=>new Response(JSON.stringify({capacity:250,total_remaining:0.000001,all_weekly_exhausted:false,retry_after_seconds:60,buckets:[{session:"",cap:250,remaining:0.000001,held:0,available:0.000001}]})));
  assert.equal(await new QuotaWaiter().waitUntilRetry(client,"unregistered",ctx(new AbortController().signal)),"retry");
});
test("server near-floor in-flight gate prevents immediate retries despite positive credit",async () => {
  const f=fixture(0.1);f.state.ready=false;f.state.inFlight=1;
  let resolved=false;const widgets:Array<string[]|undefined>=[];
  const pending=f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal,widgets)).then(r=>{resolved=true;return r;});
  try {await tick();assert.equal(resolved,false);assert.ok(widgets.some(w=>w?.join(" ").includes("Waiting for in-flight request")));
    f.state.ready=true;f.state.inFlight=0;f.waiter.wake();assert.equal(await pending,"retry");}
  finally {f.controller.abort();}
});
test("forced burn admission resumes zero-credit/debt sessions without requiring refill",async () => {
  const f=fixture();f.state.ready=false;f.state.debt=4;
  const pending=f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal));
  try {await tick();f.state.ready=true;f.waiter.wake();assert.equal(await pending,"retry");} finally {f.controller.abort();}
});
test("revoked burn readiness does not bypass session debt",async () => {
  const f=fixture();f.state.ready=false;f.state.debt=4;
  let resolved=false;const pending=f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal)).then(r=>{resolved=true;return r;});
  await tick();assert.equal(resolved,false);f.controller.abort();assert.equal(await pending,"aborted");
});
test("weekly exhaustion returns to native terminal handling even when admission-ready is true",async () => {
  const f=fixture();f.state.ready=true;f.state.weekly=true;
  assert.equal(await f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal)),"retry");
});
test("stale positive status has an abort-aware retry delay, not a tight failure loop",async t => {
  t.mock.timers.enable({apis:["Date"],now:0});const f=fixture(1);
  let resolved=false;const pending=f.waiter.waitUntilRetry(f.client,"work",ctx(f.controller.signal),60,1000).then(r=>{resolved=true;return r;});
  try {await tick();assert.equal(resolved,false);t.mock.timers.tick(1000);f.waiter.wake();assert.equal(await pending,"retry");}
  finally {f.controller.abort();}
});
