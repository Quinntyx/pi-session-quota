import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuotaClient } from "../src/quota-client.js";
import { QuotaWaiter } from "../src/waiter.js";

function ctx(signal: AbortSignal): ExtensionContext {
  return {
    signal,
    ui: {
      setStatus: () => undefined,
      setWidget: () => undefined,
      setWorkingMessage: () => undefined,
    },
  } as unknown as ExtensionContext;
}

test("waiting is pending, wakeable, and retries admission from fresh status", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => {
    requests++;
    const available = requests > 1 ? 1 : 0;
    return new Response(
      JSON.stringify({
        capacity: 250,
        total_remaining: available,
        all_weekly_exhausted: false,
        buckets: [{ session: "work", cap: 10, remaining: available, held: 0, available }],
        retry_after_seconds: 3600,
      }),
      { status: 200 },
    );
  };
  const waiter = new QuotaWaiter();
  const client = new QuotaClient({ endpoint: "http://proxy/v1/session-quota", headers: {} }, fetchImpl);
  const promise = waiter.waitUntilRetry(client, "work", ctx(new AbortController().signal), 3600);

  const sentinel = Symbol("pending");
  assert.equal(await Promise.race([promise, Promise.resolve(sentinel)]), sentinel);
  waiter.wake();
  assert.equal(await promise, "retry");
  assert.equal(requests, 2);
});

test("waiting honors cancellation", async () => {
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        capacity: 250,
        total_remaining: 0,
        all_weekly_exhausted: false,
        buckets: [{ session: "work", cap: 10, remaining: 0, held: 0, available: 0 }],
        retry_after_seconds: 3600,
      }),
      { status: 200 },
    );
  const waiter = new QuotaWaiter();
  const client = new QuotaClient({ endpoint: "http://proxy/v1/session-quota", headers: {} }, fetchImpl);
  const promise = waiter.waitUntilRetry(client, "work", ctx(controller.signal), 3600);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.equal(await promise, "aborted");
});

test("unregistered sessions wait on interactive and require enough admission credit", async () => {
  let available = 0.25;
  let resolved = false;
  const waiter = new QuotaWaiter();
  const client = new QuotaClient({endpoint:"http://proxy/v1/session-quota",headers:{}}, async () => new Response(JSON.stringify({
    capacity:250,total_remaining:available,all_weekly_exhausted:false,retry_after_seconds:60,
    buckets:[{session:"",cap:250,remaining:available,held:0,available}]
  }),{status:200}));
  const pending = waiter.waitUntilRetry(client,"unregistered",ctx(new AbortController().signal),60,0.5).then(result=>{resolved=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(resolved,false,"positive but insufficient credit must keep waiting");
  available = 1;
  waiter.wake();
  assert.equal(await pending,"retry");
});
