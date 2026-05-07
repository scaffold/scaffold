"""Empirical equilibrium analysis for the publisher/aggregator deception game,
implemented in OpenSpiel as a 2-player general-sum normal-form (matrix) game.

This is the OpenSpiel port of scripts/deception_equilibrium.ts. It uses three
solvers, and cross-checks them against the closed-form equilibrium in
docs/protocol/deception.md:

  * Lemke-Howson on the raw payoff matrices (exact, single Nash).
  * CFR on a turn-based lift of the matrix game (iterative, convergent in
    self-play).
  * Hand-rolled exploitability in normal form (works for general-sum, where
    OpenSpiel's `exploitability` doesn't apply).

Setup (OpenSpiel ships as a wheel for Linux/macOS Python 3.9-3.12):

    python -m venv .venv && source .venv/bin/activate
    pip install open_spiel numpy

Run:

    python scripts/deception_equilibrium_openspiel.py

Why use OpenSpiel here at all? The matrix form is just a sanity check on the
TS port. The real value of OpenSpiel is the upgrade path: once you trust this
result, the next step is to encode the game in extensive form with the
publisher's private knowledge of block validity as a chance node, and let CFR
discover signaling/conditioning strategies the matrix form cannot represent.
A sketch of that is at the bottom.
"""

from __future__ import annotations

import math
import warnings
from dataclasses import dataclass
from typing import Sequence

import numpy as np

# nashpy (pulled in transitively by open_spiel.python.algorithms.matrix_nash)
# emits divide-by-zero RuntimeWarnings on near-degenerate pivots that don't
# affect the returned equilibrium. Silence them here, where we know the
# fallback path is correct.
warnings.filterwarnings("ignore", category=RuntimeWarning)

import pyspiel  # noqa: E402
from open_spiel.python.algorithms import cfr  # noqa: E402
from open_spiel.python.algorithms.matrix_nash import lemke_howson_solve  # noqa: E402


# -- Stage game definition (identical to deception_equilibrium.ts) --------

@dataclass(frozen=True)
class Params:
    C1: float = 1000.0       # author collateral (decaying)
    R: float = 1000.0        # aggregator insurance
    r: float = 1.0           # honest publish reward
    v: float = 1.0           # verification cost
    f: float = 1.0           # aggregation fee paid by publisher
    alpha: float = 0.5       # finder's share of insurance payout
    c: float = 0.3           # collateral decay constant per second


PUBLISHER_ACTIONS: Sequence[str] = (
    "honest",
    "deceptive_immediate",
    "deceptive_delay_1s",
    "deceptive_delay_5s",
    "deceptive_delay_30s",
    "malicious_no_flag",
)

AGG_ACTIONS: Sequence[str] = (
    "verify_p00", "verify_p10", "verify_p25", "verify_p33",
    "verify_p50", "verify_p75", "verify_p100",
)

PROBE_RATE = {
    "verify_p00": 0.0,  "verify_p10": 0.10, "verify_p25": 0.25,
    "verify_p33": 0.33, "verify_p50": 0.50, "verify_p75": 0.75,
    "verify_p100": 1.0,
}

DELAY = {
    "deceptive_immediate": 0.0,
    "deceptive_delay_1s": 1.0,
    "deceptive_delay_5s": 5.0,
    "deceptive_delay_30s": 30.0,
}


def payoff(p: str, a: str, params: Params) -> tuple[float, float]:
    """Same expected one-shot payoff as the TS version."""
    q = PROBE_RATE[a]
    probe_cost = q * params.v

    if p == "honest":
        return (params.r - params.f, params.f - probe_cost)
    if p == "malicious_no_flag":
        return (-q * params.C1, params.f - probe_cost)

    delay = DELAY[p]
    finder = params.alpha * params.R * math.exp(-params.c * delay)
    pub = q * (-params.C1) + (1.0 - q) * finder
    agg = params.f - probe_cost - (1.0 - q) * params.R
    return (pub, agg)


def payoff_matrices(params: Params) -> tuple[np.ndarray, np.ndarray]:
    n_pub, n_agg = len(PUBLISHER_ACTIONS), len(AGG_ACTIONS)
    pub_m = np.zeros((n_pub, n_agg))
    agg_m = np.zeros((n_pub, n_agg))
    for i, p in enumerate(PUBLISHER_ACTIONS):
        for j, a in enumerate(AGG_ACTIONS):
            pub_m[i, j], agg_m[i, j] = payoff(p, a, params)
    return pub_m, agg_m


def build_game(params: Params) -> pyspiel.Game:
    pub_m, agg_m = payoff_matrices(params)
    return pyspiel.create_matrix_game(
        "deception",
        "Publisher-Aggregator Deception",
        list(PUBLISHER_ACTIONS),
        list(AGG_ACTIONS),
        pub_m.tolist(),
        agg_m.tolist(),
    )


# -- Solvers --------------------------------------------------------------

def solve_lemke_howson(params: Params) -> tuple[np.ndarray, np.ndarray] | None:
    """Direct Nash via simplex pivot. Yields one equilibrium; the matrix
    games we build here are non-degenerate, so this is exact.
    """
    pub_m, agg_m = payoff_matrices(params)
    eqs = list(lemke_howson_solve(pub_m, agg_m))
    return eqs[0] if eqs else None


def solve_cfr(params: Params, iterations: int = 5_000) -> tuple[np.ndarray, np.ndarray]:
    """CFR on the turn-based lift of the matrix game.

    `convert_to_turn_based` produces a sequential game where player 1 acts
    after player 0 but at an info state that *does not reveal* player 0's
    action -- preserving the simultaneous-move equilibrium structure.
    """
    matrix_game = build_game(params)
    seq_game = pyspiel.convert_to_turn_based(matrix_game)
    solver = cfr.CFRSolver(seq_game)
    for _ in range(iterations):
        solver.evaluate_and_update_policy()
    avg = solver.average_policy()

    # Extract per-player mixed strategies from the average policy.
    state = seq_game.new_initial_state()
    pub_probs_dict = dict(avg.action_probabilities(state))
    pub_strat = np.array([pub_probs_dict.get(i, 0.0) for i in range(len(PUBLISHER_ACTIONS))])

    # After player 0 acts (with any action -- player 1's info state ignores
    # it), advance and read player 1's strategy.
    state.apply_action(0)
    agg_probs_dict = dict(avg.action_probabilities(state))
    agg_strat = np.array([agg_probs_dict.get(i, 0.0) for i in range(len(AGG_ACTIONS))])
    return pub_strat, agg_strat


# -- Exploitability for normal-form general-sum games ---------------------
#
# OpenSpiel's `exploitability` is restricted to 2-player constant-sum
# turn-based games (see exploitability.py), and `nash_conv` requires
# constructing a TabularPolicy from a mixed-strategy vector, which is
# fiddly for matrix games. For normal form it's three lines of numpy:

def normal_form_exploitability(
    pub_strat: np.ndarray,
    agg_strat: np.ndarray,
    params: Params,
) -> tuple[float, float, str, str]:
    pub_m, agg_m = payoff_matrices(params)
    pub_payoffs_per_action = pub_m @ agg_strat       # u_pub(p, sigma_agg)
    agg_payoffs_per_action = pub_strat @ agg_m       # u_agg(sigma_pub, a)

    pub_value = float(pub_strat @ pub_payoffs_per_action)
    agg_value = float(agg_payoffs_per_action @ agg_strat)

    pub_best = int(np.argmax(pub_payoffs_per_action))
    agg_best = int(np.argmax(agg_payoffs_per_action))

    pub_gap = float(pub_payoffs_per_action[pub_best] - pub_value)
    agg_gap = float(agg_payoffs_per_action[agg_best] - agg_value)

    return pub_gap, agg_gap, PUBLISHER_ACTIONS[pub_best], AGG_ACTIONS[agg_best]


# -- Reporting ------------------------------------------------------------

def fmt_mix(actions: Sequence[str], strat: np.ndarray) -> str:
    return ", ".join(
        f"{actions[i]}={strat[i] * 100:.1f}%"
        for i in range(len(strat)) if strat[i] > 0.01
    ) or "(uniform / unmixed)"


def summarize(label: str, params: Params) -> None:
    print(f"\n=== {label} ===")

    p_analytical = params.v / params.R
    q_analytical = (params.alpha * params.R - params.r + params.f) / (
        params.alpha * params.R + params.C1
    )

    # CFR (iterative).
    pub_cfr, agg_cfr = solve_cfr(params, iterations=5_000)
    pub_gap, agg_gap, pub_dev, agg_dev = normal_form_exploitability(
        pub_cfr, agg_cfr, params
    )
    p_emp = float(sum(
        pub_cfr[PUBLISHER_ACTIONS.index(k)]
        for k in ("deceptive_immediate", "deceptive_delay_1s", "deceptive_delay_5s")
    ))
    q_emp = float(sum(agg_cfr[i] * PROBE_RATE[a] for i, a in enumerate(AGG_ACTIONS)))

    print(f"CFR pub mix:  {fmt_mix(PUBLISHER_ACTIONS, pub_cfr)}")
    print(f"CFR agg mix:  {fmt_mix(AGG_ACTIONS, agg_cfr)}")
    print(f"Empirical p={p_emp * 100:.2f}% (analytical {p_analytical * 100:.2f}%)")
    print(f"Empirical q={q_emp * 100:.2f}% (analytical {q_analytical * 100:.2f}%)")
    print(
        f"Exploitability: pub_gap={pub_gap:.4f} (best-response: {pub_dev}), "
        f"agg_gap={agg_gap:.4f} (best-response: {agg_dev})"
    )

    # Lemke-Howson cross-check.
    lh = solve_lemke_howson(params)
    if lh is not None:
        pub_lh, agg_lh = lh
        print(f"Lemke-Howson pub mix: {fmt_mix(PUBLISHER_ACTIONS, pub_lh)}")
        print(f"Lemke-Howson agg mix: {fmt_mix(AGG_ACTIONS, agg_lh)}")


# -- Sketch: lifting to imperfect-information extensive form --------------
#
# The matrix form collapses the protocol's temporal structure: publisher
# private info, observation of posted collateral, sequential challenge and
# response. To capture those, subclass pyspiel.Game in Python (see
# open_spiel/python/games/kuhn_poker.py for a template) with the structure:
#
#   chance node     -> draws block "type" (valid / invalid). Visible only to
#                      publisher (via information_state_string).
#   publisher node  -> chooses (publish honest, publish invalid, abstain) and
#                      collateral level.
#   aggregator node -> observes posted collateral and insurance, NOT validity.
#                      Chooses {probe, skip, reject}.
#   chance node     -> if probe: deterministic outcome from validity, but
#                      placed here so info-set bookkeeping stays clean.
#   publisher node  -> if invalid and aggregated: choose self-flag delay.
#   terminal        -> contract logic computes returns().
#
# Then solve and measure:
#
#   game = DeceptionGame(params)
#   solver = cfr.CFRPlusSolver(game)
#   for _ in range(N): solver.evaluate_and_update_policy()
#   pol = solver.average_policy()
#   from open_spiel.python.algorithms import exploitability as expl
#   nc = expl.nash_conv(game, pol)   # works on general-sum extensive-form
#
# This is the configuration that catches strategies the matrix form misses,
# such as "publisher signals validity through posted collateral magnitude"
# or "aggregator conditions probe rate on observed collateral level".


if __name__ == "__main__":
    print("OpenSpiel equilibrium analysis -- collateral-resolution deception game")
    summarize("Default params (alpha=0.5, R=1000, C1=1000)", Params())
    summarize("Lower insurance (R=200)", Params(R=200))
    summarize("Higher finder share (alpha=0.9)", Params(alpha=0.9))
    summarize("Slow decay (c=0.05)", Params(c=0.05))
    summarize("No collateral (C1=0)", Params(C1=0))
