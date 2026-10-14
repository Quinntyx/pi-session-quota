import assert from "node:assert/strict";
import test from "node:test";
import { QuotaClient } from "../src/quota-client.js";

const status = {
  capacity: 250,
  total_remaining: 200,
  all_weekly_exhausted: false,
  buckets: [],
  retry_after_seconds: 0,
};

test("quota client uses encoded names, model auth, and documented bodies", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(String(input).endsWith("/skim") ? { transferred: 3, quota: status } : status), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new QuotaClient(
    { endpoint: "https://proxy.example/v1/session-quota", headers: { authorization: "Bearer model-key" } },
    fetchImpl,
  );

  await client.setCap("renamed work/✓", 50);
  await client.clear("renamed work/✓");
  await client.clearAll();
  assert.equal(await client.skim(10), 3);
  await client.getStatus();

  assert.equal(requests[0].url, "https://proxy.example/v1/session-quota/sessions/renamed%20work%2F%E2%9C%93");
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(requests[0].init.body, JSON.stringify({ cap: 50 }));
  assert.equal((requests[0].init.headers as Record<string, string>).authorization, "Bearer model-key");
  assert.equal(requests[1].init.method, "DELETE");
  assert.equal(requests[2].url, "https://proxy.example/v1/session-quota/sessions");
  assert.equal(requests[3].init.body, JSON.stringify({ amount: 10, session: "" }));
  assert.equal(requests[4].init.method, undefined);
});

for (const transferred of [10 + Number.EPSILON * 8, 10 + 5e-9]) {
 test(`skim tolerates an already-applied rounding excess: ${transferred}`, async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => { calls++; return new Response(JSON.stringify({transferred}),{status:200}); };
  const client = new QuotaClient({endpoint:"https://proxy.example/v1/session-quota",headers:{}},fetchImpl);
  assert.equal(await client.skim(10),10);
  assert.equal(calls,1,"must not repeat the already-applied transfer");
 });
}
for (const transferred of [-1, 10.000001, "10", null]) {
 test(`skim still rejects invalid transfer: ${JSON.stringify(transferred)}`, async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({transferred}),{status:200});
  const client = new QuotaClient({endpoint:"https://proxy.example/v1/session-quota",headers:{}},fetchImpl);
  await assert.rejects(client.skim(10),/invalid skim result/);
 });
}

for (const invalid of [{admission_ready:"true"},{in_flight:-1},{in_flight:0.5},{debt:-1}]) {
  test(`invalid soft-cap readiness metadata is rejected: ${JSON.stringify(invalid)}`,async()=>{
    const client=new QuotaClient({endpoint:"http://proxy/v1/session-quota",headers:{}},async()=>new Response(JSON.stringify({...status,buckets:[{session:"",cap:250,remaining:1,held:0,available:1,...invalid}]})));
    await assert.rejects(client.getStatus(),/invalid status payload/);
  });
}
test("soft-cap status preserves explicit false readiness and session debt",async()=>{
  const payload={...status,admission_mode:"soft",forced_burn:{eligible:false},buckets:[{session:"work",cap:100,remaining:0,held:0,available:0,debt:7,in_flight:1,admission_ready:false}]};
  const client=new QuotaClient({endpoint:"http://proxy/v1/session-quota",headers:{}},async()=>new Response(JSON.stringify(payload)));
  assert.deepEqual(await client.getStatus(),payload);
});
