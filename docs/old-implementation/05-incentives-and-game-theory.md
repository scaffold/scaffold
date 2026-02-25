# Incentives and Game Theory

## 1. Economic primitives

- Outputs carry signed amounts.
- Claiming a positive output is a reward opportunity.
- Free-market outputs (notably frontier/data/root/etc. classes) feed into work and winner scoring.
- Requesters can publish incentive outputs to attract generation (`FetchService`).

## 2. Roles

- Requester: posts incentive for a verifier target.
- Generator: claims outputs by producing candidate blocks.
- Verifier: challenges candidate correctness through contract execution.
- Litigator/Poster: posts collateral votes on hint-path contests.

## 3. Collateral contest tree

Collateral postings are grouped by hint path into a tree.

Each node aggregates vote amounts for:

- validity-side challenge/contest,
- invalidity-side challenge/contest,
- final pass/fail/final contest.

Outcome is computed in two stages:

1. contest-type winner,
2. result winner.

Payout redistributes loser stake to winning postings (with caps/eligibility rules); remainder is burned.

## 4. Strategic properties (good)

- Open challenge surface: challengers can force explicit evidence paths.
- Hint-path structure localizes disputes.
- Burn on unresolved/losing paths reduces endless circular redistribution.
- Contest-type and result separation models burden-of-proof transitions cleanly.

## 5. Strategic weak points (current)

- Some verification driver APIs are still stubs, so advanced contracts cannot be fully adjudicated yet.
- Frontier contract execution is effectively placeholder.
- Canonical winner logic and collateral validity are not fully fused into one hard acceptance rule.
- Some guardrails rely on conventions/comments rather than strict reject-on-ingest.

## 6. Practical recommendation

Define a hard economic validity predicate:

- `StructurallyCanonical(block) && EconomicallyVerified(block)`

Where `EconomicallyVerified` requires:

- verifier group checks complete,
- collateral threshold met for disputed groups,
- no unresolved required hint path beyond configured grace window.

Then make spendability and relay priority depend on that predicate.

## 7. Parameterization advice

Keep first version small:

- fixed challenge threshold,
- fixed final-vote amount,
- deterministic payout function,
- explicit timeout windows.

Once stable, expose adaptive policies by contract class.
