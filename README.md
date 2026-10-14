# pi-session-quota

A Pi extension for CLIProxyAPI session quotas. It attributes model requests to the exact current tmux session, exposes quota commands, and keeps an active agent run pending while a provisioned quota is exhausted.

## Install

Load as a Pi git package:

```text
pi install git:git.quinntyx.dev/quinntyx/pi-session-quota@dev
```

The package declares `src/index.ts` in `package.json` under `pi.extensions`; no profile settings or separate credentials are required.

## Behavior

- The extension derives the quota API from the active model `baseUrl` and resolves that model's existing API key/headers through Pi's model registry.
- A base URL ending in `/v1` uses `/v1/session-quota`; an origin-only base URL also uses `/v1/session-quota`.
- It is gated on the selected `cliproxyapi` provider. Other providers are left untouched.
- For supported model requests, `X-CLIProxyAPI-Session` is set to the exact tmux session name. The name is queried from `TMUX_PANE` for every request, so new windows and user renames are reflected.
- Outside tmux, attribution is omitted and CLIProxyAPI uses its interactive (`""`) bucket.
- Only `provisioned_quota_exhausted` is intercepted. `weekly_quota_exhausted` remains terminal.
- Provisioned failures display “Reached provisioned quota cap, waiting for reset” instead of Codex's generic usage-limit error. An animated waiting widget shows available points and any session debt; weekly and unrelated errors keep their original text.
- Recent successful usage provides best-effort input and cache-prefix estimates. New messages/tool results and previous output are included; compaction, model changes, or edits to successful context discard the hint. A 10% cache-prefix safety margin is used. Full output allowances remain reserved, and actual upstream usage (including a cache miss) always replaces estimates. These are trusted-client estimates, not guaranteed cache hits or a security boundary.
- Normal deficits remain pending across refills and repeated admission failures: `required_points > available` is not proof of an impossible request, including when credit is held. With positive spendable balance, stale estimates are rechecked through a rebuilt request after at most 30 seconds. Apparently affordable but repeatedly rejected requests have a cancelable one-second retry delay rather than a tight loop.
- An estimate above the provisioned cap (and any currently spendable over-cap grant) gets one immediate live-context/projection-aware rebuild, even at zero balance. Only a still-impossible rebuilt estimate stops; lowered estimates or raised caps return to normal pending refill waits. Status outages remain abort-aware waits, not evidence of insufficient capacity.
- Waiting is asynchronous and abort-aware. The TUI remains responsive to Escape, commands, and steering. Status is polled at most every 30 seconds and successful quota commands wake the poll immediately.
- Before a retry, the failed assistant entry is omitted from model context with Pi's append-only `context_edit` boundary mechanism. Pi then rebuilds the request from current session context, reruns context projections, and consumes steering queued during the wait. HTTP request bytes are never replayed.
- The run does not settle while waiting. This keeps callers such as `pi-subagents` pending until a genuine completion, cancellation, terminal weekly quota error, or a rebuilt request proven unable to fit provisioned capacity.
- Quota waits also publish `session-quota:wait-state` through Pi's extension bus. Updated `pi-sock` exposes a cumulative `quotaWait` pause clock so updated `pi-subagents` can suspend execution/root deadlines instead of timing out a still-pending run. These orchestration components must be updated together; suppressing settlement alone cannot prevent an older caller's wall-clock timeout.

## Commands

```text
/quota list
/quota set <points|percent%> [session]
/quota clear [session]
/quota clear-all
/quota skim [points|percent%]
```

Subcommands support Tab completion (including the `status` alias). `/quota list` uses a Unicode box-drawing table with terminal-width-aware column alignment.

`/quota skim` defaults to 10 points and transfers into the current registered tmux session, or interactive when unregistered/outside tmux. Other funded buckets donate by assigned cap, including interactive when funding a registered session. Caps are unchanged; only spendable credit is transferred, and dry-donor shortfalls are redistributed. An explicit skim can temporarily put a balance above its cap. The `%` suffix always means absolute quota points: `20%` means 20 points, `250%` means 250 points. It never means a fraction of another value.

The default session for `set` and `clear` is the current tmux session. Without tmux, those cap commands require an explicit session. The unattributed interactive bucket is the remainder; `interactive` as an explicit session argument is a literal tmux session name. Quote tmux names containing whitespace.

## Backend contract

All endpoints use the active model's API-key authentication (not the management secret):

- `GET /v1/session-quota`
- `PUT /v1/session-quota/sessions/:encodedName` with `{ "cap": number }`
- `DELETE /v1/session-quota/sessions/:encodedName`
- `DELETE /v1/session-quota/sessions`
- `POST /v1/session-quota/skim` with `{ "amount": number, "session": "current tmux session" }` (session optional; unregistered/omitted targets interactive)

Status payload:

```json
{
  "capacity": 250,
  "total_remaining": 0,
  "all_weekly_exhausted": false,
  "buckets": [
    {
      "session": "work",
      "cap": 50,
      "remaining": 0,
      "held": 0,
      "available": 0
    }
  ],
  "retry_after_seconds": 60
}
```

The refillable local admission failure is HTTP 429 with error code and type `provisioned_quota_exhausted`, `retry_after_seconds`, and optional `required_points` (the admission estimate). A weekly failure uses `weekly_quota_exhausted` and is not caught.

The proxy's bounded request-size failure is distinct: HTTP 413, `error.code: context_too_large`, `error.type: invalid_request_error`, `retryable: false`, `required_points`, and `max_points`; its quota header identifies `request_too_large`. It is not a provisioned refill wait. Genuine provider context-overflow errors retain Pi's native compaction/recovery lifecycle; quota handling does not disable compaction or reconstruct raw durable history over the live projected context.

Because the native Codex client replaces HTTP 429 bodies with a generic ChatGPT limit message, the proxy also supplies `X-CLIProxyAPI-Quota-Code`, `X-CLIProxyAPI-Quota-Retry-After`, and `X-CLIProxyAPI-Quota-Required-Points`. The extension uses the response hook only while an assistant turn is awaiting its provider response, so typed failures from compaction model calls cannot leak into the agent lifecycle. Untyped upstream 429 errors remain native terminal/retry-policy errors. Error bodies include a `quota exceeded` reason so native Codex leaves retry scheduling to this extension instead of doing its own HTTP backoff.

## Development

```text
npm install
npm run check
```

The repository itself has no runtime dependencies beyond Pi and Node.js.

### Installed-runtime lifecycle integration

```sh
PI_QUOTA_TEST_SDK=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

This exercises installed Pi 1.1.0 sessions using both OpenAI Chat Completions and native Codex Responses against a local fake proxy: zero `agent_settled` events while pending; repeated refillable deficits with held credit; bounded 296-point estimates at zero/positive balance; projection-aware retries that become refillable; raised capacity; status-outage cancellation; canceled threshold compaction; genuine native overflow recovery; compaction-response metadata isolation; distinct typed request-size and untyped upstream failures. Sent bodies are checked for fresh transformations and steering, not raw-history replay. Cancellation and weekly exhaustion settle exactly once. Without the SDK environment variable these machine-specific tests are skipped; skipped cases are not validation. Run `npm run check` with the same environment for typechecking and the full suite.

To also exercise actual Python sync/async socket waiters beyond a deliberately
short execution deadline, set the following alongside `PI_QUOTA_TEST_SDK`:

```sh
PI_QUOTA_TEST_SOCK_EXTENSION=/absolute/path/to/pi-sock/index.ts \
PI_QUOTA_TEST_PYTHON=/absolute/path/to/venv/bin/python \
PI_QUOTA_TEST_SUBAGENTS_SOURCE=/absolute/path/to/pi-subagents/src \
PI_QUOTA_TEST_SDK=/absolute/path/to/pi-coding-agent/dist/index.js npm test
```

The six cases verify the socket reports a live pause, the Python caller remains
pending beyond its timeout, and resume, weekly exhaustion, and explicit abort
release the pause and settle exactly once. Python task/root budget regressions
are also covered in `pi-subagents`. Existing notebook kernels retain imported
Python code; restart/reset them before creating pools after an update.

## Soft-cap admission

Requests are no longer priced or rejected using context/cache/output estimates. A session with positive credit may start a request; reported token usage is converted to quota points afterwards and reconciled with upstream quota observations. This conversion remains approximate: subscription quota percentages are not a public token-price meter.

The final request can cross the assigned cap. Its session owes the overrun against future refill; another session is not charged for that overrun. Near empty, the server allows only one in-flight request. `/quota list` shows debt and in-flight count instead of monetary reservations. Escape releases the in-flight slot promptly; missing final usage is not charged as a fabricated full reservation.

During a genuine imminent-reset forced-account burn, the server may mark an empty/debt session ready so pending work can use that account. This exception ends when the forced account is no longer eligible. It does not bypass weekly exhaustion or account usage caps. Waiters honor server admission readiness and poll at most five seconds apart, while still supporting immediate wake from quota commands.
