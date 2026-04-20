# Harness Transport

Every application runs over `LatencyTransport`, a `TransportPlugin`
wrapper that composes a simulated one-way latency + jitter on top of
`UnixSocketTransport`. The wrapper looks up remote coordinates in a
`PeerDirectory` that polls the coordinator's `peers.json` manifest.

## Stack

```
           +---------------------------+
           |       Scaffold            |
           +--------------+------------+
                          |
           +--------------v------------+
           |    LatencyTransport       |   (harness/transports/LatencyTransport.ts)
           |                           |
           |  -- wraps dialAddress --  |   stashes remote coord from directory
           |  -- wraps provider send-- |   setTimeout(write, oneWayMs + jitter)
           +--------------+------------+
                          |
           +--------------v------------+
           |   UnixSocketTransport     |   (src/node/UnixSocketTransport.ts)
           |                           |
           |  main socket (anonymous)  |   /tmp/sh-<run>-<session>.sock
           |  per-handshake sockets    |   /tmp/scaffold-auth-<hex>.sock
           +--------------+------------+
                          |
                         Deno.Conn (unix)
```

## Authenticated handshake

`UnixSocketTransport` supports two modes:

1. **Anonymous.** The main listener accepts incoming connections and
   immediately creates an anonymous `ConnectionDriver`. Used for
   bootstrap (dialing anchors) and for signaling relay.
2. **Authenticated.** For every authenticated handshake, the initiator
   mints a fresh per-session socket at a random path, opens a listener
   on it, and emits `unix:<path>` via the encrypted signaling mesh.
   Only the receiver (who decrypts the envelope) learns the path and
   dials it. The path itself is the shared secret -- no token preamble
   needed, because the ephemeral socket will only ever receive one
   connection.

The initiator role is chosen with a zero-length microtask:

```ts
initializeAuthenticatedTransport: (driver) => {
  let mode: 'init' | 'recv' | undefined;
  queueMicrotask(() => {
    if (mode !== undefined) return;   // recvSignal fired first
    mode = 'init';
    // mint path, listen, sendSignal(...)
  });
  return {
    recvSignal: (signal) => {
      if (mode === undefined) mode = 'recv';
      // dial the signal's path
    },
    // ...
  };
}
```

TransportManager calls `initializeAuthenticatedTransport` on both
sides. On the receiver, `session.recvSignal(firstSignal)` runs
synchronously immediately after; by the time the microtask fires,
`mode` is already `'recv'` and the init path is skipped.

## LatencyTransport behaviour

### Outbound: dialed connections

On `dialAddress(address)`, the wrapper looks up the remote's coord in
the `PeerDirectory`. It pushes that coord onto a FIFO queue of
"pending dial coords". When the inner `UnixSocketTransport` finishes
the connect and calls `createAnonymousConnection(provider)`, the
wrapper dequeues the coord and uses it to compute one-way latency for
every send on that provider.

Caveat: the queue is FIFO by dial order, not by resolution order. If
two concurrent dials resolve out of order, their coords can swap. In
practice bootstrap dials are few and resolve quickly; fleet coord
variance is small enough that this is noise. Tighten to a
promise-keyed map if it becomes a problem (see
[TODO.md](../../TODO.md)).

### Outbound: authenticated connections

The wrapper does not know the remote pubkey when
`createAuthenticatedConnection(provider)` fires at the plugin layer,
so it falls back to `fleet_fallback_ms` for that connection's lifetime.

### Inbound: accepted connections

The inner plugin accepts a raw inbound connection and immediately
calls `createAnonymousConnection(provider)` before any data has
flowed. The wrapper has no identity info at that point, so it also
uses `fleet_fallback_ms` for outbound sends from the listener side of
the connection.

### Asymmetry consequence

Because only the **dialing** side of an anonymous connection gets
peer-specific latency, measurement-grade analysis should anchor
latency queries on the **sender** (the side that applies the delay
before the packet hits the wire). The receiver's measurement of
"elapsed time since own send" will overestimate on the
`fleet_fallback_ms` path.

Inbound-accepted peer-aware latency is a known v1 gap; see
[TODO.md](../../TODO.md).

### Silent-leave semantics

`LatencyTransport` queues outbound writes in a JS `setTimeout`. When
the process is SIGKILL'd, outstanding timers in the event loop are
abandoned -- the kernel never gets to flush them. From the receiver's
perspective, those packets simply never arrive. A send event exists
in the sender's stdout JSONL; no matching recv event exists in the
receiver's. This is exactly the evidence surfaced by
`harness/db/queries/packets_without_recv.sql`.

## PeerDirectory

`harness/transports/PeerDirectory.ts`. A small class that polls
`runs/<id>/peers.json` every 500ms and indexes it by address and by
pubkey. The coordinator writes this file atomically (tmp + rename)
on every session spawn / exit, so apps never read a half-written file.

API:

- `getByAddress(address) -> PeerEntry | undefined`
- `getByPubkey(pubkeyHex) -> PeerEntry | undefined`
- `snapshot() -> readonly PeerEntry[]`

Used by:

- `LatencyTransport.dialAddress` to stash dial coords.
- Behaviors via `ctx.directory` for peer migration.

## Configuration surface

```yaml
geography:
  latency:
    speed_factor: 0.5        # fraction of c; lower -> higher latency
    jitter_min_ms: 5         # uniform jitter floor
    jitter_max_ms: 30        # uniform jitter ceiling
    min_ms: 5                # floor after haversine + jitter
    fleet_fallback_ms: 60    # used when remote coord unknown
```

See [configs.md](./configs.md) for tuning guidance.
