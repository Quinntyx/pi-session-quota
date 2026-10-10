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
    return new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new QuotaClient(
    { endpoint: "https://proxy.example/v1/session-quota", headers: { authorization: "Bearer model-key" } },
    fetchImpl,
  );

  await client.setCap("renamed work/✓", 50);
  await client.clear("renamed work/✓");
  await client.clearAll();
  await client.skim(10);
  await client.getStatus();

  assert.equal(requests[0].url, "https://proxy.example/v1/session-quota/sessions/renamed%20work%2F%E2%9C%93");
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(requests[0].init.body, JSON.stringify({ cap: 50 }));
  assert.equal((requests[0].init.headers as Record<string, string>).authorization, "Bearer model-key");
  assert.equal(requests[1].init.method, "DELETE");
  assert.equal(requests[2].url, "https://proxy.example/v1/session-quota/sessions");
  assert.equal(requests[3].init.body, JSON.stringify({ amount: 10 }));
  assert.equal(requests[4].init.method, undefined);
});
