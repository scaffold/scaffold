---
name: debug-browser
description: Debug the Scaffold demo app via Chrome DevTools MCP. Connects to the browser, inspects block graph state, queries event logs, and diagnoses issues.
trigger: When the user asks to debug, inspect, or diagnose the running Scaffold demo app in the browser.
---

# Browser Debugging Skill

## Quick Start

1. Connect to the browser tab:
```
mcp__chrome-devtools__list_pages
mcp__chrome-devtools__select_page (select the localhost:5173 page)
```

2. Check the debug API is available:
```js
__scaffold.status()
```

3. Take a screenshot to see the visual state:
```
mcp__chrome-devtools__take_screenshot
```

## Debug API Reference

The `window.__scaffold` object is installed by the demo app. All methods return JSON-serializable data.

### Quick Status
```js
__scaffold.status()        // { totalBlocks, canonicalBlocks, logEntries, conflicts, chainLength }
```

### Event Log
```js
__scaffold.recent(20)                         // Last N log entries
__scaffold.query({ system: 'coordinator' })   // Filter by system
__scaffold.query({ event: 'blockProcessed' }) // Filter by event
__scaffold.query({ level: 'warn' })           // Filter by level (warn and above)
__scaffold.query({ since: 10, limit: 5 })     // Filter by seq range
__scaffold.history("d9f3d1")                  // All events mentioning this block hash prefix
```

### Block Inspection
```js
__scaffold.blocks()           // All blocks with summary info
__scaffold.canonical()        // Only canonical blocks
__scaffold.block("d9f3d1")    // Deep inspect by hash prefix: outputs, claims, weight, conflicts
__scaffold.chain()            // Canonical chain from tip to genesis
__scaffold.conflicts()        // All active conflicts
```

### State Queries
```js
__scaffold.utxos()              // All unspent outputs
__scaffold.utxos("9441a05a")    // UTXOs for a specific contract (by hash prefix)
__scaffold.outputSpace("d9f3")  // Extended output vector for a block
__scaffold.peers()              // Connected peers (when networking active)
```

### Raw Event Log
```js
__scaffold.log.last(10)         // Direct access to EventLog
__scaffold.log.forBlock("abc")  // Search by block hash prefix
__scaffold.log.size             // Total buffered entries
__scaffold.log.nextSeq          // Next sequence number
```

## Log Systems and Events

| System | Events | Description |
|--------|--------|-------------|
| `coordinator` | `blockReceived`, `blockProcessed`, `weightUpdate` | Block lifecycle, canonicality changes, conflicts, weight |
| `reactive` | `strategyActions`, `blockCreatedByStrategy` | Strategy evaluation and block creation |
| `gossip` | `pushDecisions`, `peerAdded`, `peerRemoved`, `deliveryConfirmed` | Gossip protocol decisions |
| `network` | `peerConnected`, `peerDisconnected`, `blockSent`, `blockReceived` | Network transport events |

## Debugging Workflow

1. **Something looks wrong in the UI** -- take a screenshot, then check `__scaffold.status()` for overview
2. **Want to understand what happened** -- use `__scaffold.recent(30)` to see the event timeline
3. **Investigating a specific block** -- use `__scaffold.block("prefix")` and `__scaffold.history("prefix")`
4. **Checking consensus** -- use `__scaffold.canonical()` and `__scaffold.conflicts()`
5. **Checking value flow** -- use `__scaffold.utxos()` and `__scaffold.outputSpace("prefix")`
6. **Network issues** -- use `__scaffold.peers()` and `__scaffold.query({ system: 'network' })`

## Adding Instrumentation to New Code

When adding a new module or service that should be observable:

### 1. Get a scoped logger from the ProtocolContext

For services constructed via DI:
```typescript
// In your service constructor
constructor(ctx: ProtocolContext) {
  this._log = ctx.logger('mymodule');
}
```

For components constructed manually (like NetworkBridge):
```typescript
constructor(deps: { logger?: ScopedLogger; /* ... */ }) {
  this._log = deps.logger;
}
// Wire in Scaffold.ts:
logger: this.eventLog ? new ScopedLogger(this.eventLog, 'mymodule') : undefined,
```

### 2. Log at key decision points

Use the right level:
- `this._log?.info(event, data)` -- state changes (block received, peer connected, weight changed)
- `this._log?.debug(event, data)` -- decisions (push targets, strategy actions)
- `this._log?.warn(event, data)` -- recoverable issues (rejected block, missing peer)
- `this._log?.error(event, data)` -- failures

Data should be a flat `Record<string, unknown>` with hex hashes:
```typescript
this._log?.info('myEvent', {
  hash: block.hash.toHex(),
  fromPeer: peerId,
  count: items.length,
});
```

### 3. Keep logging non-overwhelming

- Log state transitions, not every internal step
- Use `debug` level for high-frequency events (gossip decisions, weight updates)
- Use `info` level for significant events (block received, peer connected, conflicts)
- Include block hashes in data so `history(prefix)` can find related events

## Adding Debug API Queries

To add new state query methods to `window.__scaffold`:

1. Add the method signature to the `ScaffoldDebugAPI` interface in `src/debug/ScaffoldDebug.ts`
2. Implement it in the `createDebugAPI()` return object
3. Access internal state through `scaffold.context` (NodeContext exposes services as public fields)

Example:
```typescript
// In ScaffoldDebugAPI interface:
myQuery(arg: string): Record<string, unknown>;

// In createDebugAPI return:
myQuery(arg: string): Record<string, unknown> {
  const service = ctx.myService;
  return { /* ... */ };
},
```

## Dev Workflow

The demo app resolves `scaffold.io` imports directly to `src/` via Vite aliases. Changes to source files are picked up instantly via HMR -- no npm rebuild needed. Just edit and reload.

If you change `vite.config.ts` or add new Deno-specific dependencies, you may need to restart the Vite dev server and clear its cache (`rm -rf demo/node_modules/.vite`).
