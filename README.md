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
- Waiting is asynchronous and abort-aware. The TUI remains responsive to Escape, commands, and steering. Status is polled at most every 30 seconds and successful quota commands wake the poll immediately.
- Before a retry, the failed assistant entry is omitted from model context with Pi's append-only `context_edit` boundary mechanism. Pi then rebuilds the request from current session context and consumes steering queued during the wait. HTTP request bytes are never replayed.
- The run does not settle while waiting. This keeps callers such as `pi-subagents` pending until a genuine completion, cancellation, or terminal weekly quota error.

## Commands

```text
/quota list
/quota set <points|percent%> [session]
/quota clear [session]
/quota clear-all
/quota skim [points|percent%]
```

`/quota skim` defaults to 10 points. The `%` suffix always means absolute quota points: `20%` means 20 points, `250%` means 250 points. It never means a fraction of another value.

The default session for `set` and `clear` is the current tmux session. Without tmux, those cap commands require an explicit session. The unattributed interactive bucket is the remainder; `interactive` as an explicit session argument is a literal tmux session name. Quote tmux names containing whitespace.

## Backend contract

All endpoints use the active model's API-key authentication (not the management secret):

- `GET /v1/session-quota`
- `PUT /v1/session-quota/sessions/:encodedName` with `{ "cap": number }`
- `DELETE /v1/session-quota/sessions/:encodedName`
- `DELETE /v1/session-quota/sessions`
- `POST /v1/session-quota/skim` with `{ "amount": number }`

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

The local admission failure must contain error code and type `provisioned_quota_exhausted`, with `retry_after_seconds` and optional `required_points` (the admission estimate), so tiny positive balances do not cause repeated rejected requests. A weekly failure uses `weekly_quota_exhausted` and is not caught.

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

This exercises real Pi sessions against a local fake proxy: the run and its Future stay pending with zero `agent_settled` events during quota waits; queued steering is applied to the rebuilt request; cancellation and weekly exhaustion settle exactly once. Without the environment variable these machine-specific tests are skipped.
