# Block Filter Query Language

The block graph explorer provides a search bar for filtering which blocks are
visible. The query language uses a familiar `key:value` syntax inspired by
GitHub/Gmail search operators.

## Grammar

```
query       = term ("," term)*
term        = predicate+
predicate   = "-" predicate
            | bare_word
            | key ":" value
            | key "(" args ")"
            | hash_prefix

value       = comparison? atom
comparison  = ">" | ">=" | "<" | "<="
atom        = number | duration | bare_word

duration    = number ("s" | "m" | "h")
args        = atom ("," atom)*
hash_prefix = [0-9a-f]{4,64}
bare_word   = [a-zA-Z_][a-zA-Z0-9_]*
```

**Composition:**
- Comma `,` separates terms and acts as OR.
- Space within a term separates predicates and acts as AND.
- `-` prefix negates a single predicate.

## Predicates

### Boolean (bare word)

| Predicate   | Matches when                                         |
|-------------|------------------------------------------------------|
| `canonical` | Block is canonical per consensus                     |
| `head`      | No other block aggregates this block                 |
| `genesis`   | Block's anchor is ZERO_HASH                          |
| `leaf`      | Block's aggregates array is empty                    |

### Comparison (key:value)

| Key          | Operators     | Description                              |
|--------------|---------------|------------------------------------------|
| `weight`     | `>` `>=` `<` `<=` `=` | Block's `declaredWeight`        |
| `throughput` | `>` `>=` `<` `<=` `=` | Sum of output values             |
| `age`        | `<` `<=` `>` `>=`     | Time since `receivedAt`. Value is a duration: `30s`, `5m`, `1h`. `age:<1m` means "received less than 1 minute ago." |

### Function (key(args))

| Function             | Description                                              |
|----------------------|----------------------------------------------------------|
| `outputs(hex_prefix)` | Block has at least one output whose `verifier.contract` hex starts with the given prefix |

### Hash prefix

A raw hex string (4--64 characters) matches the single block whose hash starts
with that prefix.

## Default Query

The default query is `canonical head`, which shows canonical blocks that have
not been aggregated -- the current unaggregated chain tips.

## Filtering Behavior

1. **Empty query**: no blocks are shown (except pinned/focused).
2. **Pinned and focused blocks** are always shown, regardless of the query.
3. **Ghost nodes**: a block that does not match the query but is directly
   connected (via anchor, aggregate, or ref edge) to a visible block is shown
   as a dimmed ghost node. Ghost nodes let the user click through to walk the
   graph. Blocks with no visible neighbors vanish entirely.
4. **Reactivity**: the filter re-evaluates whenever blocks are added, removed,
   or change status (canonical, aggregated, etc.). With the default query, new
   unaggregated canonical blocks appear automatically and aggregated blocks
   disappear.

## Visual States

| State        | Appearance                                    |
|--------------|-----------------------------------------------|
| Matched      | Compact node: hash prefix, status, weight     |
| Focused      | Full-detail expanded card                     |
| Pinned       | Full-detail expanded card with pin indicator  |
| Ghost        | Dimmed, smaller node (hash prefix only)       |
| Filtered out | Invisible                                     |
