import assert from "node:assert/strict";
import test from "node:test";
import { splitArguments } from "../src/args.js";
import { parseProvisionedQuotaError } from "../src/errors.js";
import { parsePoints } from "../src/points.js";
import { quotaEndpoint } from "../src/quota-client.js";
import { resolveTmuxSession } from "../src/tmux.js";

test("percent sign always means absolute quota points", () => {
  assert.deepEqual(parsePoints("20%"), { points: 20, source: "percent" });
  assert.deepEqual(parsePoints("12.5%"), { points: 12.5, source: "percent" });
  assert.deepEqual(parsePoints("250%"), {points:250,source:"percent"});
  assert.throws(() => parsePoints("251%"), /250/);
  assert.throws(() => parsePoints("251"), /250/);
});

test("quota endpoint follows the active API base URL", () => {
  assert.equal(quotaEndpoint("http://127.0.0.1:8317/v1"), "http://127.0.0.1:8317/v1/session-quota");
  assert.equal(quotaEndpoint("http://127.0.0.1:8317"), "http://127.0.0.1:8317/v1/session-quota");
  assert.equal(quotaEndpoint("https://proxy.example/api/v1/"), "https://proxy.example/v1/session-quota");
});

test("tmux lookup targets TMUX_PANE and preserves the exact session name", async () => {
  const calls: string[] = [];
  const name = await resolveTmuxSession({ TMUX_PANE: "%42" }, async (pane) => {
    calls.push(pane);
    return "Renamed Session ✓";
  });
  assert.equal(name, "Renamed Session ✓");
  assert.deepEqual(calls, ["%42"]);
  assert.equal(await resolveTmuxSession({}, async () => "wrong"), null);
});

test("argument parser preserves quoted session names", () => {
  assert.deepEqual(splitArguments('set 20% "renamed work"'), ["set", "20%", "renamed work"]);
  assert.throws(() => splitArguments('set 10 "broken'), /Unterminated/);
});

test("only the provisioned quota error code is recognized", () => {
  assert.deepEqual(
    parseProvisionedQuotaError('429 {"error":{"code":"provisioned_quota_exhausted","retry_after_seconds":12}}'),
    { retryAfterSeconds: 12 },
  );
  assert.equal(parseProvisionedQuotaError('429 {"error":{"code":"weekly_quota_exhausted"}}'), null);
});
