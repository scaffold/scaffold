## Summary

Create the public API entry point: `new Scaffold(config)`, `scaffold.fetch()`, `scaffold.put()`, `scaffold.close()`, `scaffold.context`.

## Dependencies

- 00-folder-reorganization
- 03-node-context

## Design

- Scaffold class lives at `src/Scaffold.ts`
- Constructor takes ScaffoldConfig, creates NodeContext
- `fetch(verifier, options)` delegates to FetchManager
- `put(request)` delegates to PutManager
- `close()` tears down NodeContext (stops strategies, closes connections, flushes storage)
- `context` getter exposes NodeContext for expert users
- Config validation on construction (check genesis is provided, etc.)

## Interface

As specified in docs/client-interface.md.

## Implementation Notes

- Config has sensible shape but NO defaults for plugins (the library is pure).
- Genesis block is created from config.genesis and processed through coordinator on construction.
- If timePlugin provided, start background behaviors. If not, library is purely reactive.
- If networkPlugins provided, start them and connect to bootstrapPeers.

## Testing

Unit test with no plugins (local-only mode). Test fetch/put round-trip.
