# Harness Applications

An "application" in the harness is a Deno entrypoint that imports
`Scaffold`, participates in the network, and emits observability events
to stdout. Each running instance is a **session**; one end-user keypair
is checked out to the session for its lifetime.

## AppContext

Every behavior receives an `AppContext` from `runApplication()`:

```ts
interface AppContext {
  scaffold: Scaffold;         // a live Scaffold instance, already started
  runId: string;              // shared across the fleet
  sessionId: string;          // e.g. 'social_media-23'
  application: string;        // the app name from YAML
  coord: { lat, lon };        // assigned by geography
  params: Record<string, unknown>;  // verbatim from YAML params
  directory: PeerDirectory;   // live peer manifest snapshot
  random: Rng;                // seeded from RUN_ID + SESSION_ID
  log(event: string, data?: object): void;  // emits a kind: 'app' event
  sleep(ms: number): Promise<void>;         // cancellable via shouldStop
  shouldStop(): boolean;                    // true after SIGTERM
}
```

## Minimal behavior

```ts
#!/usr/bin/env -S deno run --allow-all
import { runApplication } from '../App.ts';

runApplication(async (ctx) => {
  ctx.log('started_custom_behavior');

  while (!ctx.shouldStop()) {
    // do something scaffold-related, e.g. scaffold.fetch(...)
    ctx.log('tick', { peers: ctx.directory.snapshot().length });
    await ctx.sleep(2000);
  }

  ctx.log('finishing');
});
```

## V1 behavior set

All live under `harness/applications/behaviors/`:

| Behavior        | Purpose                                             |
|-----------------|-----------------------------------------------------|
| `anchor`        | Long-lived backbone node; new apps bootstrap to it  |
| `aggregator`    | Long-lived participant; emits heartbeats            |
| `social_media`  | Scrolls a simulated feed; exercises peer migration  |
| `money_send`    | Issues periodic transfer intents to random peers    |
| `validator`     | Long-lived verification participant                 |

All v1 behaviors emit `app`-kind events describing their intent. They
do not yet call `scaffold.put()` / `scaffold.fetch()` against real
contracts; that's a follow-up (see [TODO.md](../../TODO.md)).

## Event stream contract

Each behavior emits two kinds of stdout lines:

### kind=event: from Scaffold's EventLog

```json
{"runId":"r-1","sessionId":"social_media-12","wallTs":1776000000000,
 "kind":"event","seq":42,"ts":1234.5,"system":"network","event":"peerConnected",
 "level":"info","data":{"peerId":"03ab.."}}
```

Emitted automatically via `scaffold.eventLog.onAppend`. You don't
need to do anything to get these.

### kind=app: from your behavior

```json
{"runId":"r-1","sessionId":"social_media-12","wallTs":1776000000000,
 "kind":"app","seq":3,"event":"feed_view","level":"info",
 "data":{"scroll":5,"followed":"03..."}}
```

Emitted via `ctx.log(event, data)`. The `seq` is a per-session
monotonic counter distinct from the EventLog's scaffold `seq`. The
postgres schema uses `(run_id, session_id, kind, seq)` as the primary
key, so scaffold events and app events coexist without collision.

### Additional lifecycle events emitted by the App runtime

- `started` -- session fully constructed (pubkey, coord, socket path)
- `bootstrap_dialed` / `bootstrap_failed` -- outbound connection attempts
- `peer_connected` / `peer_disconnected`
- `sigterm_received`
- `session_timer_elapsed`
- `behavior_error` (level=error; stack trace in data)
- `closing`, `close_error`, `exited`

## Peer migration

`AppContext.directory` exposes a live snapshot of the peer manifest
written by the coordinator. Behaviors can use this to implement peer
migration -- drop a high-latency peer and reconnect to a closer one --
by:

1. Periodically calling `ctx.directory.snapshot()`.
2. Comparing candidates' `coord` against `ctx.coord`.
3. Calling `scaffold.disconnectPeer(peerId)` + `scaffold.connectToPeer(remotePubkey)`.

V1 `social_media` exercises a simple form of this via its
`peerMigrationRate` parameter -- it randomly drops and repicks its
"followed" peer on each scroll tick. Behaviors can extend this to
more realistic migration policies.

## How to surface a new metric

1. Emit an `app`-kind event with enough data to compute the metric:
   ```ts
   ctx.log('send_intent', { requestId: id, destination: dest.pubkeyHex,
                             contract: contractHash, amount });
   ```
2. If the metric is a latency, emit a correlating `reply` event on the
   destination side with the same `requestId`.
3. Add a compute function to an existing file under
   `harness/analysis/metrics/*.ts`, or create a new family.
4. Add thresholds to `harness/analysis/thresholds.yaml`.
5. Run the evaluation config and commit the updated metrics.

See [analyzer.md](./analyzer.md) for the full pipeline.

## Params convention

Behavior params live under YAML `applications[].params`. They're
JSON-stringified into the `PARAMS_JSON` env var, then parsed inside the
app. Keep field names camelCase so Deno's lint rules stay happy.
Prefer nested shapes for distributions:

```yaml
scrollIntervalMs: { mean: 2000, stddev: 400 }
amount: { min: 1, max: 100 }
```

The behavior's TypeScript file declares an interface for its params and
uses defaults when keys are missing -- so adding a new param is a
non-breaking change.
