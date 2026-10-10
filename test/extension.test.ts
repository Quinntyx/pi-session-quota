import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { createExtension } from "../src/index.js";
import { SESSION_HEADER } from "../src/types.js";

const quotaStatus = {
  capacity: 250,
  total_remaining: 50,
  all_weekly_exhausted: false,
  buckets: [{ session: "renamed-two", cap: 50, remaining: 50, held: 0, available: 50 }],
  retry_after_seconds: 0,
};

function harness(fetchImpl: typeof fetch, resolveSession: () => Promise<string | null>) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => undefined;
    },
    registerCommand(name: string, options: { handler: typeof command }) {
      assert.equal(name, "quota");
      command = options.handler;
    },
  } as unknown as ExtensionAPI;
  createExtension({ fetch: fetchImpl, resolveSession })(pi);
  return { handlers, get command() { return command!; } };
}

function context(notifications: Array<[string, string | undefined]> = []): ExtensionContext {
  const model = {
    id: "test",
    name: "test",
    provider: "cliproxyapi",
    api: "openai-completions",
    baseUrl: "http://proxy.test/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  return {
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "model-key" }),
    },
    signal: new AbortController().signal,
    ui: {
      notify: (message: string, type?: string) => notifications.push([message, type]),
      setStatus: () => undefined,
      setWidget: () => undefined,
      setWorkingMessage: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const localErrorMessage = '429 {"error":{"code":"provisioned_quota_exhausted","type":"provisioned_quota_exhausted","retry_after_seconds":1}}';
const assistantError = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: localErrorMessage,
};

test("injects the exact freshly queried tmux name only for the CLIProxyAPI provider", async () => {
  let session = "renamed-one";
  const fetchImpl: typeof fetch = async () => response(quotaStatus);
  const extension = harness(fetchImpl, async () => session);
  const hook = extension.handlers.get("before_provider_headers")![0];
  const ctx = context();

  const first = { type: "before_provider_headers", headers: {} as Record<string, string> };
  await hook(first, ctx);
  assert.equal(first.headers[SESSION_HEADER], "renamed-one");

  session = "renamed-two";
  const second = { type: "before_provider_headers", headers: {} as Record<string, string> };
  await hook(second, ctx);
  assert.equal(second.headers[SESSION_HEADER], "renamed-two");
});

test("unsupported providers and no-tmux sessions are untouched", async () => {
  const unsupported = harness(async () => response({ error: "not found" }, 404), async () => "must-not-appear");
  const unsupportedEvent = { type: "before_provider_headers", headers: { existing: "yes" } };
  const otherContext = context();
  otherContext.model!.provider = "other";
  await unsupported.handlers.get("before_provider_headers")![0](unsupportedEvent, otherContext);
  assert.deepEqual(unsupportedEvent.headers, { existing: "yes" });

  const interactive = harness(async () => response(quotaStatus), async () => null);
  const interactiveEvent = { type: "before_provider_headers", headers: {} };
  await interactive.handlers.get("before_provider_headers")![0](interactiveEvent, context());
  assert.equal(SESSION_HEADER in interactiveEvent.headers, false);
});

test("quota wait remains inside lifecycle and pre-settlement retry omits stale error context", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return response(quotaStatus);
  };
  const extension = harness(fetchImpl, async () => "renamed-two");
  const ctx = context();
  const turnEvent = {
    type: "turn_end",
    message: assistantError,
    messageEntryId: "failed-entry",
  } as unknown as TurnEndEvent;

  const turnResult = await extension.handlers.get("turn_end")![0](turnEvent, ctx);
  assert.deepEqual(turnResult.entries,[{type:"context_edit",targetId:"failed-entry",replacement:null}]);
  assert.ok(calls >= 1, "eligibility status was queried");

  const settleEvent = {
    type: "agent_before_settle",
    outcome: "error",
    context: {
      contextEntries: [{ sourceEntry: { id: "failed-entry" }, messages: [assistantError] }],
      contextMessages: [assistantError],
      llmMessages: [],
      pendingMessages: [],
      canContinue: false,
    },
  } as unknown as AgentBeforeSettleEvent;
  const result = await extension.handlers.get("agent_before_settle")![0](settleEvent, ctx);
  assert.deepEqual(result, { continue: true });
});

test("weekly quota errors are not caught", async () => {
  const extension = harness(async () => response(quotaStatus), async () => "renamed-two");
  const ctx = context();
  const event = {
    type: "turn_end",
    message: { ...assistantError, errorMessage: '{"error":{"code":"weekly_quota_exhausted"}}' },
    messageEntryId: "weekly",
  } as unknown as TurnEndEvent;
  assert.equal(await extension.handlers.get("turn_end")![0](event, ctx), undefined);
});

test("commands use current model auth and enforce explicit sessions outside tmux", async () => {
  const requests: Array<{ url: string; method?: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    requests.push({ url: String(input), method: init.method, body: init.body as string | undefined });
    return response(quotaStatus);
  };
  const extension = harness(fetchImpl, async () => null);
  const notices: Array<[string, string | undefined]> = [];
  const ctx = context(notices) as ExtensionCommandContext;

  await extension.command("set 20%", ctx);
  assert.match(notices.at(-1)![0], /specify a session explicitly/);

  await extension.command("set 20% interactive", ctx);
  assert.equal(requests.at(-1)!.url, "http://proxy.test/v1/session-quota/sessions/interactive");
  assert.equal(requests.at(-1)!.body, JSON.stringify({ cap: 20 }));
});

for (const code of ["provisioned_quota_exhausted", "weekly_quota_exhausted", "usage_limit_reached"]) {
  test(`native Codex friendly errors are caught only for provisioned header: ${code}`, async () => {
    let calls = 0;
    const extension = harness(async () => { calls++; return response(quotaStatus); }, async () => "renamed-two");
    const ctx = context();
    await extension.handlers.get("after_provider_response")![0]({status:429,headers:{"X-CLIProxyAPI-Quota-Code":code,"X-CLIProxyAPI-Quota-Retry-After":"1","X-CLIProxyAPI-Quota-Required-Points":"0.5"}},ctx);
    const result = await extension.handlers.get("turn_end")![0]({type:"turn_end",message:{...assistantError,errorMessage:"You have hit your ChatGPT usage limit."},messageEntryId:"native-failure"},ctx);
    assert.equal(calls > 0, code === "provisioned_quota_exhausted");
    assert.equal(result?.continue, code === "provisioned_quota_exhausted" ? true : undefined);
  });
}


test("skim defaults to ten points and reports the actual transfer", async () => {
  const notifications: Array<[string, string | undefined]> = [];
  const requests: RequestInit[] = [];
  const h = harness(async (_input, init = {}) => {
    requests.push(init);
    return new Response(JSON.stringify({ transferred: 3, quota: quotaStatus }), { status: 200 });
  }, async () => "renamed-two");
  await h.command("skim", context(notifications) as ExtensionCommandContext);
  assert.equal(requests[0].body, JSON.stringify({ amount: 10 }));
  assert.match(notifications[0][0], /Skimmed 3 quota points/);
});
