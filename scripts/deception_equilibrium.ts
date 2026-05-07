// Empirical equilibrium analysis for the publisher/aggregator deception game.
//
// What this script does:
//
//   1. Encodes the publisher x aggregator stage game as a payoff matrix.
//      The strategy spaces are richer than the binary {honest, deceptive} x
//      {verify, skip} described in docs/protocol/deception.md -- we add
//      delayed-reveal strategies for the publisher and probe-rate-tuning
//      strategies for the aggregator. Adding strategies is exactly how you
//      stress-test a closed-form equilibrium: if a richer strategy space
//      yields a Nash with different mixing weights, the closed-form was
//      missing a deviation.
//
//   2. Runs regret matching (Hart & Mas-Colell, 2000), the simplest member
//      of the CFR family, until average strategies converge.
//
//   3. Reports exploitability: max_a [u_i(a, sigma_{-i})] - u_i(sigma).
//      If exploitability is ~0 the candidate strategy profile is an
//      epsilon-Nash; if it's positive, the deviating action is the
//      "unreasonable profit" the user is worried about.
//
//   4. Cross-checks the empirical mixing rates against the analytical
//      p = v / R and q = (alpha*R - r + f) / (alpha*R + C1) from the doc.
//
// Run: deno run scripts/deception_equilibrium.ts

// -- Stage game definition --------------------------------------------------

interface Params {
  C1: number; // author collateral (decaying)
  R: number; // aggregator insurance (= throughput proxy)
  r: number; // honest publish reward
  v: number; // verification cost
  f: number; // aggregation fee paid by publisher
  alpha: number; // finder's share of insurance payout on rectification
  c: number; // collateral decay constant per second
}

const DEFAULT_PARAMS: Params = {
  C1: 1000,
  R: 1000,
  r: 1,
  v: 1,
  f: 1,
  alpha: 0.5,
  c: 0.3,
};

// Publisher actions. The first two are the doc's binary case. The rest
// are deviations we want to check are not profitable.
const PUBLISHER_ACTIONS = [
  'honest',
  'deceptive_immediate', // self-flag at t=0
  'deceptive_delay_1s', // wait 1s before self-flagging
  'deceptive_delay_5s', // wait 5s
  'deceptive_delay_30s', // pure data-hiding attack
  'malicious_no_flag', // never self-flag (hope state persists)
] as const;
type PublisherAction = typeof PUBLISHER_ACTIONS[number];

// Aggregator actions: probe with various probabilities. A continuous
// strategy is approximated by a fine grid.
const AGG_ACTIONS = [
  'verify_p00',
  'verify_p10',
  'verify_p25',
  'verify_p33',
  'verify_p50',
  'verify_p75',
  'verify_p100',
] as const;
type AggAction = typeof AGG_ACTIONS[number];

const PROBE_RATE: Record<AggAction, number> = {
  verify_p00: 0.0,
  verify_p10: 0.1,
  verify_p25: 0.25,
  verify_p33: 0.33,
  verify_p50: 0.5,
  verify_p75: 0.75,
  verify_p100: 1.0,
};

// Expected one-shot payoff to (publisher, aggregator) given pure actions.
//
// Notes:
// - With probability `q` the aggregator probes and catches a deceptive
//   block (publisher loses C1, aggregator pays only verification cost).
// - Otherwise the deceptive publisher self-flags. Their finder's reward
//   is alpha * R * exp(-c * delay). Aggregator pays out R minus their
//   fee, which they keep regardless.
// - Honest blocks: publisher gets r - f, aggregator gets f - q*v.
// - Malicious-no-flag: publisher gains 0 (no flag = no claim), aggregator
//   loses nothing in this model -- this row exists to expose any
//   accidental positive payoff for not flagging.
function payoff(p: PublisherAction, a: AggAction, params: Params): [number, number] {
  const q = PROBE_RATE[a];
  const { C1, R, r, v, f, alpha, c } = params;

  const probeCost = q * v;

  if (p === 'honest') {
    return [r - f, f - probeCost];
  }
  if (p === 'malicious_no_flag') {
    // Publisher posts collateral but never flags. With prob q the
    // aggregator probes and catches them => publisher loses C1.
    // With prob 1-q nothing happens; the collateral decays back to them
    // (-> 0 net), and the aggregator earns f.
    return [-q * C1, f - probeCost];
  }

  const delay = {
    deceptive_immediate: 0,
    deceptive_delay_1s: 1,
    deceptive_delay_5s: 5,
    deceptive_delay_30s: 30,
  }[p];

  const finderReward = alpha * R * Math.exp(-c * delay);

  // Caught with prob q: publisher loses C1.
  // Slipped through with prob 1-q: publisher self-flags, gains finderReward.
  const pubExpected = q * (-C1) + (1 - q) * finderReward;

  // Aggregator earns fee f, pays verification cost q*v. If a deceptive
  // block slips through (prob 1-q) and is flagged, aggregator's
  // insurance pays out R (whole pot consumed by finder + restoration).
  const aggExpected = f - probeCost - (1 - q) * R;

  return [pubExpected, aggExpected];
}

// -- Regret matching -------------------------------------------------------

class RegretMatcher<A extends string> {
  private regretSum: Record<A, number>;
  private strategySum: Record<A, number>;
  constructor(private actions: readonly A[]) {
    this.regretSum = Object.fromEntries(actions.map((a) => [a, 0])) as Record<A, number>;
    this.strategySum = Object.fromEntries(actions.map((a) => [a, 0])) as Record<A, number>;
  }
  // Current strategy = positive-part of regrets, normalized.
  strategy(): Record<A, number> {
    const pos = Object.fromEntries(
      this.actions.map((a) => [a, Math.max(0, this.regretSum[a])]),
    ) as Record<A, number>;
    const total = Object.values(pos).reduce((s, x) => s + x, 0);
    if (total > 0) {
      for (const a of this.actions) pos[a] = pos[a] / total;
    } else {
      for (const a of this.actions) pos[a] = 1 / this.actions.length;
    }
    for (const a of this.actions) this.strategySum[a] += pos[a];
    return pos;
  }
  observe(actionUtilities: Record<A, number>, played: Record<A, number>) {
    const expected = this.actions.reduce(
      (s, a) => s + played[a] * actionUtilities[a],
      0,
    );
    for (const a of this.actions) {
      this.regretSum[a] += actionUtilities[a] - expected;
    }
  }
  averageStrategy(): Record<A, number> {
    const total = Object.values(this.strategySum).reduce((s, x) => s + x, 0);
    if (total === 0) {
      return Object.fromEntries(
        this.actions.map((a) => [a, 1 / this.actions.length]),
      ) as Record<A, number>;
    }
    return Object.fromEntries(
      this.actions.map((a) => [a, this.strategySum[a] / total]),
    ) as Record<A, number>;
  }
}

function solve(params: Params, iterations = 50_000) {
  const pub = new RegretMatcher(PUBLISHER_ACTIONS);
  const agg = new RegretMatcher(AGG_ACTIONS);

  for (let t = 0; t < iterations; t++) {
    const sigPub = pub.strategy();
    const sigAgg = agg.strategy();

    // Counterfactual utility of each pub action against current agg mix.
    const pubUtil = Object.fromEntries(
      PUBLISHER_ACTIONS.map((p) => {
        let u = 0;
        for (const a of AGG_ACTIONS) u += sigAgg[a] * payoff(p, a, params)[0];
        return [p, u];
      }),
    ) as Record<PublisherAction, number>;

    const aggUtil = Object.fromEntries(
      AGG_ACTIONS.map((a) => {
        let u = 0;
        for (const p of PUBLISHER_ACTIONS) u += sigPub[p] * payoff(p, a, params)[1];
        return [a, u];
      }),
    ) as Record<AggAction, number>;

    pub.observe(pubUtil, sigPub);
    agg.observe(aggUtil, sigAgg);
  }

  return { pub: pub.averageStrategy(), agg: agg.averageStrategy() };
}

// Exploitability: how much a player gains by best-responding to the
// opponent's strategy minus the value they get from their own strategy.
// Sum over both players. Exploitability = 0 means an exact Nash; small
// positive means epsilon-Nash; large means there is a profitable deviation.
function exploitability(
  sigPub: Record<PublisherAction, number>,
  sigAgg: Record<AggAction, number>,
  params: Params,
): { pub: number; agg: number; deviating: { pub: PublisherAction; agg: AggAction } } {
  const pubVals = PUBLISHER_ACTIONS.map((p) => {
    let u = 0;
    for (const a of AGG_ACTIONS) u += sigAgg[a] * payoff(p, a, params)[0];
    return { p, u };
  });
  const pubBest = pubVals.reduce((b, x) => (x.u > b.u ? x : b));
  const pubCurrent = pubVals.reduce((s, x) => s + sigPub[x.p] * x.u, 0);

  const aggVals = AGG_ACTIONS.map((a) => {
    let u = 0;
    for (const p of PUBLISHER_ACTIONS) u += sigPub[p] * payoff(p, a, params)[1];
    return { a, u };
  });
  const aggBest = aggVals.reduce((b, x) => (x.u > b.u ? x : b));
  const aggCurrent = aggVals.reduce((s, x) => s + sigAgg[x.a] * x.u, 0);

  return {
    pub: pubBest.u - pubCurrent,
    agg: aggBest.u - aggCurrent,
    deviating: { pub: pubBest.p, agg: aggBest.a },
  };
}

// -- Main -----------------------------------------------------------------

function fmt(rec: Record<string, number>): string {
  return Object.entries(rec)
    .filter(([_, v]) => v > 0.01)
    .map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`)
    .join(', ') || '(uniform / unmixed)';
}

function summary(label: string, params: Params) {
  const { pub, agg } = solve(params);
  const exp = exploitability(pub, agg, params);

  // Analytical reference values from the doc.
  const pAnalytical = params.v / params.R;
  const qAnalytical = (params.alpha * params.R - params.r + params.f) /
    (params.alpha * params.R + params.C1);

  // Empirical fraud rate = total weight on any deceptive action.
  const pEmpirical = ['deceptive_immediate', 'deceptive_delay_1s', 'deceptive_delay_5s']
    .reduce((s, k) => s + (pub[k as PublisherAction] ?? 0), 0);
  const qEmpirical = AGG_ACTIONS.reduce(
    (s, a) => s + agg[a] * PROBE_RATE[a],
    0,
  );

  console.log(`\n=== ${label} ===`);
  console.log(`Publisher mix: ${fmt(pub)}`);
  console.log(`Aggregator mix: ${fmt(agg)}`);
  console.log(
    `Empirical p=${(pEmpirical * 100).toFixed(2)}% (analytical ${(pAnalytical * 100).toFixed(2)}%)`,
  );
  console.log(
    `Empirical q=${(qEmpirical * 100).toFixed(2)}% (analytical ${(qAnalytical * 100).toFixed(2)}%)`,
  );
  console.log(
    `Exploitability: pub=${exp.pub.toFixed(3)} (best-response: ${exp.deviating.pub}), ` +
      `agg=${exp.agg.toFixed(3)} (best-response: ${exp.deviating.agg})`,
  );
}

if (import.meta.main) {
  console.log('Empirical equilibrium analysis for collateral-resolution deception game');
  summary('Default params (alpha=0.5, R=1000, C1=1000)', DEFAULT_PARAMS);
  summary('Lower insurance (R=200) -- expected: fraud rate up', {
    ...DEFAULT_PARAMS,
    R: 200,
  });
  summary('Higher finder share (alpha=0.9) -- expected: probe rate up', {
    ...DEFAULT_PARAMS,
    alpha: 0.9,
  });
  summary('Slow decay (c=0.05) -- delayed reveal becomes attractive', {
    ...DEFAULT_PARAMS,
    c: 0.05,
  });
  summary('No collateral (C1=0) -- malicious-no-flag becomes free', {
    ...DEFAULT_PARAMS,
    C1: 0,
  });
}
