# Scheduled rebalance and portfolio alarms: what is actually possible

Research for two proposed capabilities:

1. **Scheduled rebalance** — periodically pull real E\*TRADE positions, compare
   against target weights, surface the resulting buy/sell orders.
2. **Portfolio alarms** — watch holdings and fire an alert when a position moves
   beyond a configurable up/down percentage.

Both are wanted as things that happen _without a human present_. That single
requirement is what the whole document turns on, and it is the requirement the
MCP architecture cannot satisfy.

Everything below is marked **verified** (run locally, or read in the installed
type definitions / the published specification) or **inferred**.

---

## A. The fundamental constraint

### A.1 A stdio server is a subprocess, and it dies with its client

The stdio binding is explicit about the process lifecycle (**verified**,
[spec 2026-07-28, stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)):

- "the client launches the MCP server as a subprocess"
- "Servers **SHOULD** exit promptly when their standard input is closed or reads
  return end-of-file. This is the primary graceful-shutdown signal and the only
  portable one"
- shutdown escalates to `SIGTERM` then `SIGKILL` if the server does not exit

So the process exists only for the span of one client connection. A `setInterval`
inside it stops when the client quits, and the codebase already depends on that
being true — `src/data/etrade.ts` unrefs the OAuth keep-alive timer with the
comment:

> An MCP server exits when its client disconnects; a live timer must not be the
> thing that keeps the process alive after that.

That is the correct behaviour for a keep-alive. It is also a demonstration that
in-process timers are not a scheduling mechanism: the one timer this server
already has is deliberately built so it cannot outlive the session.

There is a second, subtler reason a stdio server cannot schedule anything. The
process is started by _each_ client, so there is no single instance. Claude Code,
Claude Desktop and Cursor open three separate `cigar-butt` processes against the
same sqlite files. Whatever fires an alarm must be one thing, not one per client.

### A.2 The server cannot initiate anything, on any transport

The 2026-07-28 revision removed server-initiated requests outright
(**verified**, [transports overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)):

> A binding **MUST** deliver client-sent _requests_ and _notifications_ to the
> server, and server-sent _responses_ and _notifications_ to the client. No other
> message direction exists: […] servers do not initiate JSON-RPC requests and
> clients do not send JSON-RPC responses.

And the stdio page: "The server **MUST NOT** write JSON-RPC _requests_ to
`stdout`."

The SDK enforces this. `Server.createMessage`, `Server.elicitInput` and
`Server.listRoots` carry this doc comment (**verified**, installed
`@modelcontextprotocol/server@2.0.0`,
`dist/createMcpHandler-CLhGwQTn.d.mts`):

> Throws on a 2026-07-28-era request — use `inputRequired` (multi-round-trip)
> instead […] The 2025 push-style server-to-client request model is replaced by
> `input_required` results in the 2026-07-28 protocol.

Elicitation and sampling are therefore not push channels at all now. They are
_interim results to a request the client already made_ (the MRTR pattern, SEP-2322),
which is exactly how `src/tools/setup.ts` uses `inputRequired`. A server can only
ask a question while answering; it can never start the conversation.

### A.3 What server→client primitives remain, and whether any reaches an absent user

Over stdio the server may write exactly three kinds of message (**verified**,
stdio binding):

1. Responses, correlated by JSON-RPC `id`.
2. Notifications relating to an in-flight request — `notifications/progress`,
   `notifications/message`.
3. Notifications for an active `subscriptions/listen` request, tagged with
   `io.modelcontextprotocol/subscriptionId`.

| Primitive                                                  | Status in 2026-07-28                                                                | Requires                                                                                                            | Reaches a user not in a session? |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `notifications/message` (logging)                          | **Deprecated** (SEP-2577); migrate to stderr                                        | An in-flight request that set `io.modelcontextprotocol/logLevel` in `_meta`; servers **MUST NOT** emit it otherwise | No                               |
| `notifications/progress`                                   | Active                                                                              | An in-flight request carrying a progress token                                                                      | No                               |
| `subscriptions/listen` + `notifications/resources/updated` | Active; replaced `resources/subscribe` and the HTTP GET stream                      | A client that opened a long-lived listen stream and opted into `resourceSubscriptions`                              | No                               |
| Elicitation                                                | Active, but reshaped into `InputRequiredResult`                                     | The client to have called a tool                                                                                    | No                               |
| Sampling                                                   | **Deprecated** (SEP-2577), and reshaped into MRTR                                   | The client to have called a tool                                                                                    | No                               |
| Roots                                                      | **Deprecated** (SEP-2577)                                                           | —                                                                                                                   | No                               |
| Tasks                                                      | Moved **out of core** into the `io.modelcontextprotocol/tasks` extension (SEP-2663) | See A.4                                                                                                             | No                               |

Every row is "no", and for the same reason: each one is a message written onto a
connection that a client opened. No connection, no message. There is no MCP
primitive that produces a notification on a machine where no MCP client is
running, and none is planned — the message-direction rule above forecloses it.

Two implementation details worth recording:

- `notifications/message` is now gated per-request: the changelog states servers
  "**MUST NOT** emit `notifications/message` for requests that did not include
  this field". Logging cannot be used as a background channel even during a
  session.
- The SDK exposes the publish seam for `subscriptions/listen` only on the HTTP
  handler. `createMcpHandler` returns an `McpHttpHandler` with `.notify`
  (a `ServerNotifier`: `toolsChanged`, `promptsChanged`, `resourcesChanged`,
  `resourceUpdated(uri)`) and `.bus`. `serveStdio` returns
  `StdioServerHandle`, which has only `close()` — it accepts a
  `maxSubscriptions` option but hands back no notifier or bus (**verified**,
  `dist/stdio.d.mts`). Publishing resource-updated events from the stdio entry
  has no documented public seam in this SDK version. (**Inferred**: the older
  `Server.sendResourceUpdated` / `sendToolListChanged` methods still exist and
  presumably serve the legacy era; I did not confirm their behaviour on a modern
  stdio connection.)

### A.4 The tasks primitive does not help, and in this SDK does not exist

The name suggests durable background work. It is not that.

- **Spec** (**verified**, changelog): tasks moved out of the core protocol into
  the official `io.modelcontextprotocol/tasks` extension. The redesign "replaces
  the blocking `tasks/result` method with polling via `tasks/get`", adds
  `tasks/update` for client-to-server input, and removes `tasks/list`.
- **Semantics**: a task is a handle for one long-running _request_. The client
  still initiates it, and the client still polls `tasks/get` for the outcome. It
  makes a slow `tools/call` resumable across a broken stream. It does not let a
  server run work nobody asked for, and it does not survive the process — the
  stdio page says active listen streams "must also be re-established after
  restart", and a task handle held only in a dead process's memory is gone with it.
- **SDK** (**verified**): every task symbol the SDK exports — `Task`,
  `TaskStatus`, `TaskMetadata`, `TaskCreationParams`, `CreateTaskResult`,
  `GetTaskRequest`/`Result`, `GetTaskPayloadRequest`/`Result`,
  `ListTasksRequest`/`Result`, `CancelTaskRequest`/`Result`,
  `TaskStatusNotification`, `TaskAugmentedRequestParams` — carries the same
  JSDoc tag:

  > `@deprecated` 2025-11-25 wire vocabulary with no SDK runtime; kept importable
  > for interoperability only.

  They are type declarations for a wire format the SDK does not implement. There
  is nothing to call. **Tasks are out.**

### A.5 Does streamable HTTP change the picture?

Partly, and not in the direction that matters.

What it buys:

- The process is long-lived and independent of any one client, so `setInterval`
  works.
- `subscriptions/listen` gives a real push channel to clients that hold a stream
  open.
- The SDK supports it: `createMcpHandler`, `WebStandardStreamableHTTPServerTransport`,
  `PerRequestHTTPServerTransport`, plus `requireBearerAuth`,
  `verifyBearerToken`, `buildOAuthProtectedResourceMetadata` and origin/host
  validation helpers (**verified**, `dist/index.d.mts`).

What it costs:

- **Auth becomes mandatory.** The moment this is reachable beyond loopback it is
  an endpoint that reads a brokerage account. That means bearer tokens or full
  OAuth 2.1 with protected-resource metadata, plus `Origin`/`Host` validation
  against DNS rebinding.
- **Credential storage moves.** Today every secret lives in a 0600 file in the
  user's config dir and never leaves the machine. Hosting this puts SEC contact
  details, price-provider keys and — the real problem — a live E\*TRADE OAuth
  access token on a server the user does not physically control.
- **Hosting.** Something must run it, restart it, and hold TLS. That is a
  different product from an npm package you `claude mcp add`.
- **It still does not solve the problem.** A notification on a
  `subscriptions/listen` stream reaches whoever is holding that stream open. A
  user asleep with no editor running holds none. The spec also removed SSE
  resumability (`Last-Event-ID`) in this revision, so a dropped stream loses the
  in-flight request rather than replaying it — notifications sent while nobody
  was listening are simply gone.

Streamable HTTP fixes "the process can run a timer". It does not fix "a human who
is not in a session can be told something", which is the actual requirement for
an alarm.

### A.6 The constraint, stated plainly

> An MCP server — on any transport — can only speak in reply to a client that is
> currently connected. Alarms therefore cannot be an MCP feature. Something
> outside MCP must own the clock and own the delivery; MCP's job is to report
> what that something found.

---

## B. Host-by-host support

The question for each host is not "does it support MCP" — most do. It is whether
anything in the host can call a tool **with no human taking a turn**.

Only Claude Code is installed on this machine, so it is the only host whose
behaviour was checked by running it. Every other host below rests on published
documentation and is marked accordingly.

### B.1 Claude Code (the user's primary environment)

Checked against a local install, **version 2.1.269** (`claude --version`).

**MCP config** (**verified**, `claude mcp --help`): stdio, HTTP, SSE (marked
deprecated) and WebSocket. Scopes `local`, `project` (`.mcp.json`), `user`
(`~/.claude.json`), plus plugins and claude.ai connectors. Adding this server is
`claude mcp add cigar-butt -- npx cigar-butt`.

**Hooks** (`.claude/settings.json`). Events are all reactive: `SessionStart`,
`SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
`StopFailure`, `Notification`, `PermissionRequest`, `Elicitation`. **There is no
time-based hook event** — no cron trigger, no timer trigger. Handlers can be
`command`, `http`, `prompt`, `agent`, or `mcp_tool` (so a hook _can_ call an MCP
tool directly), but only ever in response to something a session did. Useless as
a scheduler.

**`/loop`** (**verified** in docs; reported by research against the installed
docs): schedules a prompt or slash command on an interval _inside an open
session_. Minimum interval 1 minute, 7-day expiry, up to 30 minutes of
deterministic jitter, max 50 tasks, tasks fire between turns. Backed by
`CronCreate`/`CronList`/`CronDelete`. It is session-scoped: **close the terminal
and it stops.** Restored on `claude --resume`, except the self-paced form.

**Background agents** (**verified**, `claude --help`, `claude agents --help`):
`claude --bg "prompt"`, managed with `claude agents / attach / logs / stop / rm /
respawn`. These run locally under a supervisor daemon in `~/.claude/daemon/`, so
they survive the terminal closing (not a machine shutdown), and they load MCP
servers from the session config. But a background agent is a long-running
_conversation_, not a timer — it does its task and idles. Not a scheduler either.

**Cloud routines** (the `/schedule` skill; **note**: there is no `claude schedule`
subcommand — **verified**, it is absent from `claude --help`). Routines run on
Anthropic-managed cloud infrastructure, on a 5-field cron with a **1-hour
minimum**, and the user's machine does not need to be on. That last property is
what makes them useless here: a cloud routine has no access to the local
filesystem, so it cannot reach a stdio server on the user's Mac, cannot read the
0600 credential file, and cannot see the E\*TRADE token. It can use claude.ai
connectors only.

**Headless `claude -p`** (**verified**, `claude --help` shows `-p, --print`,
`--mcp-config <configs...>` and `--strict-mcp-config`). This is the one that
works: launchd or cron invokes `claude -p "…" --mcp-config <file>`, Claude Code
starts, loads the stdio server, calls tools, prints, exits. No terminal needed,
no session held open. Exit code is usable for error handling. Note `--bare` skips
MCP auto-discovery, so don't use it here.

**Verdict:** the only real scheduling paths are `claude -p` under the OS
scheduler (works, costs model tokens per run) and `/loop` (needs a terminal
open). Nothing inside Claude Code fires an MCP tool on a clock by itself.

---

## C. Alerting channels that actually work

Assume the deciding architecture is a local process on the user's Mac that wakes
on a timer. These are its realistic outputs.

| Channel                                                        | Credential                                         | Reaches user away from the machine | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS notification via `osascript -e 'display notification …'` | None                                               | No                                 | Zero setup, zero dependency. Silently drops if Focus/DND is on, and the banner is gone in seconds with no history. Fine as a nudge, useless as the only channel.                                                                                                                                                                                                                                                                                                                                                        |
| `terminal-notifier`                                            | None (but a `brew install`)                        | No                                 | Better than `osascript`: clickable, sticks in Notification Center, can carry a URL. Costs an external binary — check for it, degrade to `osascript`.                                                                                                                                                                                                                                                                                                                                                                    |
| Slack / Discord incoming webhook                               | Yes — the webhook URL _is_ the secret              | Yes (phone push via their app)     | One `POST` of a JSON body, no SDK. Best signal-to-effort ratio. The URL must live in the 0600 store. **`redactUrl` in `src/http/client.ts` will not protect it**: it rewrites the query parameters `apikey`/`api_key`/`apiKey`/`token`, and a Slack webhook carries its secret in the _path_ (`/services/T…/B…/…`), so a failed POST through `fetchJson` would put the whole webhook in an `HttpError` message. Either extend `redactUrl` to blank the path on known webhook hosts, or send alerts outside `fetchJson`. |
| ntfy.sh                                                        | None for a public topic                            | Yes                                | A `POST` to `https://ntfy.sh/<topic>` pushes to the phone app. No account. **The topic name is the only access control** — anyone who guesses it reads your holdings. Only acceptable with a long random topic, and it still puts position data on a third party's server.                                                                                                                                                                                                                                              |
| Pushover                                                       | Yes (user key + app token), and a one-off purchase | Yes                                | Reliable, has priority/retry semantics for a genuine alarm. Two credentials to manage.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Email (SMTP)                                                   | Yes (host, user, password / app password)          | Yes                                | Universal, and everyone already has it. But SMTP needs a client library (nothing in `node:*` does it), which is a new dependency, and Gmail-style app passwords are a support burden. Deliverability is somebody else's mood.                                                                                                                                                                                                                                                                                           |
| Append to a file (JSONL / markdown)                            | None                                               | No                                 | Not an alert by itself, but the honest system of record. Cheap, greppable, and the thing an MCP tool can read back into a session. Should always be written, whatever else fires.                                                                                                                                                                                                                                                                                                                                       |
| sqlite row                                                     | None                                               | No                                 | Same as above and better structured. This is the channel the MCP server reads.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| MCP notification to a connected client                         | None                                               | **No**                             | Only reaches a client currently holding a stream. Nice-to-have, never the delivery guarantee. See A.3.                                                                                                                                                                                                                                                                                                                                                                                                                  |

Practical conclusions:

- **Two channels always on by default, both credential-free**: the sqlite/JSONL
  record, and a local OS notification. That makes the feature work the moment it
  is installed.
- **One optional credentialed channel for reach**: a webhook URL. It is a single
  string, it needs no dependency, and it is the only cheap way to reach a phone.
- **Never put an account number, an account ID key or a cash balance in an
  outbound alert body by default.** A webhook is a third party. Ticker, move
  percentage, price and the price's date are enough to act on; anything more is
  opt-in and stated as such.

---

## D. Recommendation

### D.1 Options considered

| #   | Option                                                                                                                   | Verdict                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Host-level scheduling (`claude -p` under launchd, or a Claude Code routine) calling existing MCP tools                   | **Runner-up.** Works today with zero code, and it is what to tell users now. Rejected as the shipped design — see D.5. |
| 2   | A scheduled command in the same npm package, own sqlite state, alerting directly; the MCP server reads the same database | **Recommended.**                                                                                                       |
| 3   | Streamable HTTP with in-process timers                                                                                   | Rejected: buys a timer, does not buy delivery, and moves brokerage tokens onto a host. See A.5.                        |
| 4   | The MCP tasks primitive                                                                                                  | Rejected: no SDK runtime, now an extension, poll-based, still client-initiated. See A.4.                               |

### D.2 The recommended design

Ship a second entry point in the same package: **`cigar-butt watch`**, a
short-lived process that runs one poll cycle and exits, invoked by the operating
system's scheduler.

Not a resident daemon. launchd (and systemd, and Task Scheduler) already solve
restart-on-crash, run-after-wake, survive-logout and run-on-a-calendar, and a
hand-rolled daemon with a pidfile solves none of them as well. It also matches
how this codebase already thinks: state lives in sqlite precisely because
processes are short-lived (see the note at the top of `src/cache/store.ts`).

```
launchd timer ─▶ cigar-butt watch run ─▶ quotes / E*TRADE ─▶ evaluate rules
                                                                 │
                                          watch.sqlite ◀─────────┤
                                                                 └─▶ deliver
                                                                     (OS + webhook)
      Claude Code ─▶ cigar-butt (stdio MCP) ─▶ reads watch.sqlite ─▶ watch_* tools
```

The MCP server never schedules anything. It reports.

#### New CLI surface

`src/index.ts` currently calls `serveStdio(createServer)` unconditionally. It
branches on `process.argv[2]`, and **bare `cigar-butt` must stay the stdio
server** so every existing `claude mcp add` line keeps working.

| Command                                    | Does                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cigar-butt watch run`                     | One poll cycle. What the timer calls. Exits non-zero on failure so launchd/cron logs it.                                                                                 |
| `cigar-butt watch install`                 | Writes `~/Library/LaunchAgents/dev.cigar-butt.watch.plist` with a `StartCalendarInterval`, or prints a systemd user timer / cron line on Linux. Never installs silently. |
| `cigar-butt watch uninstall`               | Removes it.                                                                                                                                                              |
| `cigar-butt watch status`                  | Last run, next run, rule count, snapshot age, broker token state.                                                                                                        |
| `cigar-butt watch rules add \| list \| rm` | Rule management from a shell.                                                                                                                                            |
| `cigar-butt watch test <channel>`          | Sends one dummy alert. Nobody should discover a broken webhook during a 20% drawdown.                                                                                    |

#### New MCP tools

All in a new `src/tools/watch.ts`, wired into `createServer()`:

| Tool                | Annotations                                                             | Purpose                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `watch_status`      | `readOnlyHint: true`, `openWorldHint: false`                            | Is a timer installed, when did it last run and with what outcome, how old is the positions snapshot, is the E\*TRADE token alive. |
| `watch_alerts`      | `readOnlyHint: true`, `openWorldHint: false`                            | Fired-alert history: ticker, reference price and its date, observed price and its date, move, which rule, which channels took it. |
| `watch_rules`       | `readOnlyHint: true`, `openWorldHint: false`                            | List the armed rules.                                                                                                             |
| `watch_rule_set`    | `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` | Create or update a rule.                                                                                                          |
| `watch_rule_remove` | `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: false`  | Delete a rule.                                                                                                                    |

The two writing tools do write local state, so `readOnlyHint` is honestly
`false`. That is not a breach of the read-only rule: the rule is that this server
never places an order and never mutates anything at the broker, and these do
neither. `setup_credentials` already writes to disk on the same reasoning.

Anything `watch_alerts` returns that implies a portfolio decision gets
`DISCLAIMER`, per hard rule 7.

#### `watch.sqlite`

A third database beside `cache.sqlite` and `congress.sqlite`, for the reason
`src/data/congress-index.ts` gives for being separate from the cache: different
lifetime. The cache expires by design; alert history must not. Same conventions —
`node:sqlite`, WAL, `synchronous = NORMAL`, `STRICT` tables, path under
`XDG_CACHE_HOME`/`~/.cache/cigar-butt/`, overridable with `CIGAR_BUTT_WATCH_DB`.

Decimal columns are `TEXT`, holding the `Decimal.toString()`, never `REAL` —
hard rule 1 applies to persisted figures too, and a threshold comparison against
a float that went through sqlite is exactly the class of bug that rule exists for.

```sql
CREATE TABLE IF NOT EXISTS rules (
  id          TEXT PRIMARY KEY,
  kind        TEXT    NOT NULL,   -- 'move' | 'drift' | 'broker_auth'
  ticker      TEXT,               -- NULL = every held name
  up_pct      TEXT,               -- decimal string; NULL = not armed upward
  down_pct    TEXT,               -- decimal string; NULL = not armed downward
  baseline    TEXT    NOT NULL,   -- 'reference' | 'previous_close' | 'cost'
  cooldown_s  INTEGER NOT NULL,
  rebaseline  INTEGER NOT NULL,   -- 1 = reset reference after firing
  channels    TEXT    NOT NULL,   -- JSON array of channel ids
  enabled     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS rule_state (
  rule_id         TEXT    NOT NULL,
  ticker          TEXT    NOT NULL,
  reference_price TEXT    NOT NULL,
  reference_as_of TEXT    NOT NULL,  -- the quote's date, not the write's
  armed           INTEGER NOT NULL,  -- hysteresis latch
  last_fired_at   INTEGER,
  PRIMARY KEY (rule_id, ticker)
) STRICT;

CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY,
  rule_id         TEXT    NOT NULL,
  ticker          TEXT,
  fired_at        INTEGER NOT NULL,
  reference_price TEXT    NOT NULL,
  observed_price  TEXT    NOT NULL,
  observed_as_of  TEXT    NOT NULL,
  move_fraction   TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  delivered       TEXT    NOT NULL   -- JSON: channel id -> 'ok' | error string
) STRICT;

CREATE TABLE IF NOT EXISTS snapshots (
  taken_at        INTEGER PRIMARY KEY,
  source          TEXT    NOT NULL,  -- 'etrade' | 'manual'
  account_id_key  TEXT,
  holdings        TEXT    NOT NULL,  -- JSON, plan_rebalance `holdings` shape
  cash            TEXT    NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
  started_at  INTEGER PRIMARY KEY,
  finished_at INTEGER,
  outcome     TEXT NOT NULL,         -- 'ok' | 'partial' | 'failed' | 'blind'
  detail      TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS alerts_fired ON alerts (fired_at);
```

`snapshots.holdings` deliberately stores the exact JSON shape `etrade_positions`
already emits for `plan_rebalance`, so a drift rule is `planRebalance()` called
on stored inputs with no adapter, and a session can plan a rebalance from the
snapshot when the broker is unreachable.

#### Avoiding alert storms

Four mechanisms, all needed, none sufficient alone:

1. **Cooldown** per `(rule_id, ticker)` from `last_fired_at`. Default 6 hours —
   long enough that a name cannot fire twice in a session, short enough that a
   second leg down the same week is still news.
2. **Hysteresis latch.** `armed` clears on fire and only resets when the price
   comes back inside half the threshold. Without this a name sitting at exactly
   −10.0% re-fires every cycle the moment the cooldown lapses.
3. **Re-baselining.** With `rebaseline = 1`, firing resets `reference_price` to
   the observed price, so a name falling 30% fires at −10, −20, −30 rather than
   holding a single alarm open through the whole slide. Off by default; on is
   right for a fast-moving book.
4. **One notification per cycle.** Every fire in a cycle is collated into one
   message. Twelve separate banners on a market-wide down day is the same as no
   banner.

Plus a **market-hours gate**: no polling outside 09:30–16:00 US Eastern on a
weekday. It halves the quota burn and stops an overnight ADR print firing an
alarm nobody can act on.

#### Quota, and the honest latency

This is a real limit and the design must not pretend otherwise. From
`src/cache/store.ts`: Alpha Vantage ~25 requests/day, Polygon 5/minute, Tiingo
~50 unique tickers/hour. A 20-name book polled every 15 minutes is 80 quotes an
hour — that is Alpha Vantage's whole day in twenty minutes, and it exceeds
Tiingo's hourly ticker budget.

So:

- **Default poll interval: 60 minutes**, aligned with the `prices` TTL. At that
  interval a 20-name book costs 20 quotes an hour and the cache never serves a
  figure older than the poll.
- A shorter interval is allowed but must (a) bypass the price cache, or it will
  compare against a quote up to an hour stale — precisely the failure hard rule 3
  exists to prevent — and (b) print the resulting request rate at
  `watch install` time and refuse to install if it exceeds the configured
  provider's documented limit.
- `watch status` reports the effective alarm latency, so nobody believes they
  have a tripwire when they have an hourly check.

An hourly alarm is what free price tiers buy. Say that out loud rather than
shipping a 5-minute default that quietly 429s.

#### Authenticating to E\*TRADE unattended

This is the hard part, and it is partly unsolvable. From `src/data/etrade.ts`:

> Two expiries, and they are not the same thing. An access token is inactivated
> after two hours with no requests against it — `renewAccessToken` revives that
> one. Every token also dies at midnight US Eastern regardless of activity, and
> no renewal survives it; the user must authorise again.

And there is no refresh token: the flow is request token → the user opens a
browser → E\*TRADE shows a five-character verifier → the human types it back.
`oob` callback, nothing to redirect to. **No unattended process can complete
that.** Broker access across a day boundary is impossible, not merely awkward.

The design therefore splits the watch into two tiers with different dependencies:

**Tier 1 — price alarms. No broker needed, runs indefinitely.**
Evaluates `move` rules against the stored `snapshots` holdings using quotes from
the normal `quote()` fallback chain. Its only credential is a price-provider API
key, which is a static string that does not expire. This runs across midnight,
across weekends, unattended, forever. It covers essentially all of "portfolio
monitoring with alarms".

**Tier 2 — position refresh and rebalance drift. Needs a live token.**
Calls `etrade_positions`' underlying functions to refresh the snapshot and
evaluates `drift` rules through `planRebalance`. Available only while a token is
alive — in practice, from whenever the user authorised until midnight ET.

The daemon's behaviour around the token:

- Each run calls `renewIfStale()` first. The existing 90-minute logic already
  covers the two-hour idle window, and a scheduled run every 60 minutes keeps the
  token warm as a side effect — the idle expiry effectively stops being a problem
  once the watch is installed.
- When renewal fails or a read 401s, the run **does not fail silently**. It
  writes `outcome = 'partial'`, fires a distinct `broker_auth` alert
  ("E\*TRADE authorisation expired — run `etrade_connect` to reauthorise") on the
  same channels, and applies a 12-hour cooldown to it so the user is told once
  per morning rather than hourly all night.
- Tier 1 continues against the last snapshot. Every alert it produces from a
  stale snapshot states the snapshot's age. Hard rule 3 is not suspended because
  the broker is down: an alarm computed from a two-day-old share count says so.

So the honest operating model is: **the user reauthorises E\*TRADE once each
trading morning; price alarms need no attention at all.** That is a limitation of
E\*TRADE's OAuth, not of the design, and it should be stated in the README rather
than engineered around.

#### What it must refuse to do

Non-negotiable, and worth an explicit test each:

- **Never place, modify or cancel an order.** No E\*TRADE order endpoint is ever
  called. The scheduled rebalance produces a `RebalancePlan` and nothing else.
  Automating execution is the one change that turns this from a research tool
  into something that can lose money while its owner sleeps.
- **Never auto-execute a plan**, and never phrase an alert as an instruction.
  `plan_rebalance` output is a plan; the existing "Execute the sells before the
  buys" prose is guidance to a human, not a trigger.
- **Never put a credential, account number, account ID key or cash balance in an
  outbound alert body** by default. A webhook is a third party. Account
  identifiers are opt-in and off.
- **Never fire on an undated or unresolvable figure.** If a quote could not be
  fetched, the run records `outcome = 'blind'` for that name and says so in
  `watch_status`. A watch that quietly stops watching is worse than no watch.
- **Never widen `readOnlyHint`.** The MCP tools remain read-only against market
  and broker.
- **Never write to stdout from anything the stdio entry can reach.** The watch
  code shares modules with the server; `eslint/no-console` stays an error in
  `src/`, and the watch's own output goes through a logger that targets stderr or
  the log file, chosen by whether it is running under `serveStdio`.

### D.3 What the user can do today, with no code

Worth documenting immediately, because it works now:

```
# ~/Library/LaunchAgents/dev.cigar-butt.check.plist → runs at 10:00 and 15:00 ET
claude -p "Use cigar-butt: read my E*TRADE positions for account <key>, plan a
rebalance against my targets, and if any position has moved more than 10% since
yesterday post a summary to my Slack webhook." \
  --mcp-config ~/.config/cigar-butt/mcp.json
```

This is real and it is the runner-up option. Its limits are why it is not the
shipped answer — see D.5.

### D.4 Impossible, or requires a terminal to stay open

| Claim                                                  | Status                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| An MCP server notifies a user with no client connected | **Impossible.** No message direction exists for it (A.2).                                                                       |
| An MCP stdio server runs a timer between sessions      | **Impossible.** The process is killed with the client (A.1).                                                                    |
| Unattended E\*TRADE access across midnight US Eastern  | **Impossible.** No refresh token; the verifier is typed by a human (D.2).                                                       |
| A Claude Code cloud routine calling this stdio server  | **Impossible.** It runs in Anthropic's cloud with no access to the local filesystem or the 0600 credential file.                |
| `/loop` as a scheduler                                 | **Requires a terminal to stay open.** Session-scoped by construction.                                                           |
| Sub-15-minute alarm latency on free price tiers        | Not impossible, but quota-infeasible for a book of any size (D.2).                                                              |
| Streamable HTTP reaching an absent user                | **Impossible** — and this revision also removed SSE resumability, so notifications sent to nobody are lost, not replayed (A.5). |

### D.5 Why the alternatives lose

**Option 1, host-level scheduling.** `claude -p` under launchd genuinely works,
loads MCP servers via `--mcp-config`, and costs nothing to build. Rejected as the
product because: it spends model tokens every hour doing arithmetic that is
deterministic and already implemented in `src/portfolio/`; a model cannot be
relied on to apply a cooldown correctly because the cooldown state has to live
somewhere and "somewhere" is a database it would have to be told to read and
write every time; the delivery channel becomes whatever the model decides to do
that run; and it makes the feature Claude-Code-specific, when the same npm
package is installed in Cursor and Claude Desktop. `/loop` and cloud routines are
worse still — one needs a terminal open, the other cannot see the local machine.

**Option 3, streamable HTTP.** Analysed at A.5. It solves the timer and not the
delivery, and it relocates brokerage tokens off the user's machine to do it. If a
hosted multi-user cigar-butt is ever the goal this is the transport, but it is a
different product and it does not deliver this feature.

**Option 4, tasks.** No runtime in the installed SDK (every symbol tagged
`@deprecated … no SDK runtime`), now an out-of-core extension, poll-based, and
still initiated by a client. Nothing to build on.

### D.6 Sources

Specification (all read directly):

- [Transports overview, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [stdio binding, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [Key changes, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
  — SEP-2575 (statelessness, `subscriptions/listen`), SEP-2322 (MRTR),
  SEP-2663 (tasks → extension), SEP-2577 (roots/sampling/logging deprecated)

SDK (read in `node_modules/@modelcontextprotocol/server@2.0.0/dist/`):

- `index.d.mts` — the full export surface
- `createMcpHandler-CLhGwQTn.d.mts` — `Server`, `McpHttpHandler`,
  `ServerNotifier`, `ServerEventBus`, and the `@deprecated … no SDK runtime`
  tags on every task symbol
- `stdio.d.mts` — `serveStdio`, `ServeStdioOptions`, `StdioServerHandle`

Repository:

- `src/data/etrade.ts` — OAuth 1.0a lifecycle, the two expiries, the unref'd
  keep-alive timer
- `src/cache/store.ts` — sqlite conventions, TTLs, the free-tier quota figures
- `src/data/congress-index.ts` — the precedent for a second, non-expiring sqlite
- `src/portfolio/rebalance.ts`, `src/tools/portfolio.ts` — `planRebalance` and
  the `holdings` / `targets` shapes
- `src/http/client.ts` — `redactUrl`'s actual coverage

Local CLI (run on 2026-09-12): `claude --version` → 2.1.269;
`claude --help`; `claude mcp --help`.

### D.7 Suggested build order

1. `watch.sqlite` + rule/state/alert model, and the pure evaluator
   (`evaluateRules(snapshot, quotes, rules, state, now)` → fires + next state).
   Pure, time-injected, and the only part where a bug is a wrong answer rather
   than a crash — test it the way `planRebalance` is tested, including the
   cooldown, latch and re-baseline paths.
2. Channels: sqlite record → OS notification → webhook. `watch test` from day one.
3. `cigar-butt watch run` wiring Tier 1 only. Ship it. Price alarms are the
   capability that works unattended and forever.
4. `watch install` / `uninstall` for launchd, and the latency/quota check.
5. The `watch_*` MCP tools.
6. Tier 2: snapshot refresh, `drift` rules, and the `broker_auth` alert.
