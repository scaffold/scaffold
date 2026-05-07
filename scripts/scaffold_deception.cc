// Scaffold publisher/aggregator deception game as an OpenSpiel C++ matrix
// game. Mirrors scripts/deception_equilibrium.ts and
// scripts/deception_equilibrium_openspiel.py. Once registered, this game is
// callable from Python as `pyspiel.load_game("scaffold_deception")` and
// from C++ as `LoadGame("scaffold_deception")`.
//
// To use this:
//
//   1. Clone OpenSpiel:
//        git clone https://github.com/google-deepmind/open_spiel.git
//        cd open_spiel
//        ./install.sh
//
//   2. Copy this file into the repo:
//        cp scaffold_deception.cc open_spiel/games/
//
//   3. Add the build target. Open open_spiel/games/CMakeLists.txt and append
//      to the GAME_SOURCES list:
//        scaffold_deception.cc
//      (No header file -- this is a single-translation-unit registration.)
//
//   4. Build:
//        mkdir build && cd build
//        cmake -DPython3_EXECUTABLE=$(which python3) ../open_spiel
//        make -j
//
//   5. From Python (with the local build on PYTHONPATH):
//        import pyspiel
//        game = pyspiel.load_game(
//            "scaffold_deception(C1=1000.0,R=1000.0,r=1.0,v=1.0,f=1.0,"
//            "alpha=0.5,c=0.3)")
//        # or with defaults:
//        game = pyspiel.load_game("scaffold_deception")
//        # then run any solver: cfr, lemke-howson, fictitious_play, etc.
//
// Why bother with C++ at all when the Python matrix game works fine?
// Three reasons:
//   * Speed for solvers that walk the game tree (CFR, exploitability,
//     best_response). The Python matrix game crosses the C++/Python
//     boundary on every state transition; a C++ game stays inside C++.
//     For this 6x7 game that's irrelevant, but for the eventual
//     extensive-form lift (chance + sequential decisions) it matters.
//   * Native registration. Once registered the game is discoverable
//     under its short_name everywhere -- Python, C++ tests, the
//     example_game_tree binary, the algorithms test harness.
//   * Forces the schema. Game parameters become first-class typed
//     fields, which is useful when sweeping ranges.

#include <memory>
#include <string>
#include <vector>

#include "open_spiel/abseil-cpp/absl/strings/str_cat.h"
#include "open_spiel/game_parameters.h"
#include "open_spiel/matrix_game.h"
#include "open_spiel/spiel.h"

namespace open_spiel {
namespace scaffold_deception {
namespace {

using matrix_game::MatrixGame;

// Action labels. Order is load-bearing -- payoff matrices below are flat
// row-major arrays indexed (publisher_idx * num_agg + aggregator_idx).
const std::vector<std::string> kPublisherActions = {
    "honest",
    "deceptive_immediate",
    "deceptive_delay_1s",
    "deceptive_delay_5s",
    "deceptive_delay_30s",
    "malicious_no_flag",
};

const std::vector<std::string> kAggregatorActions = {
    "verify_p00", "verify_p10", "verify_p25", "verify_p33",
    "verify_p50", "verify_p75", "verify_p100",
};

constexpr double kProbeRate[] = {0.0, 0.10, 0.25, 0.33, 0.50, 0.75, 1.0};

// Indexed by publisher action. NaN where unused (honest, malicious_no_flag).
constexpr double kDelay[] = {0.0 /*unused*/, 0.0, 1.0, 5.0, 30.0,
                             0.0 /*unused*/};

struct Params {
  double C1 = 1000.0;
  double R = 1000.0;
  double r = 1.0;
  double v = 1.0;
  double f = 1.0;
  double alpha = 0.5;
  double c = 0.3;
};

// One-shot expected payoff for a (publisher, aggregator) pure pair.
// Identical formula to the TS and Python ports.
std::pair<double, double> Payoff(int pub_idx, int agg_idx, const Params& p) {
  const double q = kProbeRate[agg_idx];
  const double probe_cost = q * p.v;

  // honest
  if (pub_idx == 0) {
    return {p.r - p.f, p.f - probe_cost};
  }
  // malicious_no_flag
  if (pub_idx == 5) {
    return {-q * p.C1, p.f - probe_cost};
  }
  const double delay = kDelay[pub_idx];
  const double finder = p.alpha * p.R * std::exp(-p.c * delay);
  const double pub = q * (-p.C1) + (1.0 - q) * finder;
  const double agg = p.f - probe_cost - (1.0 - q) * p.R;
  return {pub, agg};
}

const GameType kGameType{
    /*short_name=*/"scaffold_deception",
    /*long_name=*/"Scaffold Publisher-Aggregator Deception",
    GameType::Dynamics::kSimultaneous,
    GameType::ChanceMode::kDeterministic,
    GameType::Information::kOneShot,
    GameType::Utility::kGeneralSum,
    GameType::RewardModel::kTerminal,
    /*max_num_players=*/2,
    /*min_num_players=*/2,
    /*provides_information_state_string=*/true,
    /*provides_information_state_tensor=*/true,
    /*provides_observation_string=*/true,
    /*provides_observation_tensor=*/true,
    /*parameter_specification=*/
    {
        {"C1", GameParameter(1000.0)},
        {"R", GameParameter(1000.0)},
        {"r", GameParameter(1.0)},
        {"v", GameParameter(1.0)},
        {"f", GameParameter(1.0)},
        {"alpha", GameParameter(0.5)},
        {"c", GameParameter(0.3)},
    }};

std::shared_ptr<const Game> Factory(const GameParameters& gp) {
  Params p;
  p.C1 = ParameterValue<double>(gp, "C1", 1000.0);
  p.R = ParameterValue<double>(gp, "R", 1000.0);
  p.r = ParameterValue<double>(gp, "r", 1.0);
  p.v = ParameterValue<double>(gp, "v", 1.0);
  p.f = ParameterValue<double>(gp, "f", 1.0);
  p.alpha = ParameterValue<double>(gp, "alpha", 0.5);
  p.c = ParameterValue<double>(gp, "c", 0.3);

  const int n_pub = static_cast<int>(kPublisherActions.size());
  const int n_agg = static_cast<int>(kAggregatorActions.size());
  std::vector<double> pub_utilities(n_pub * n_agg);
  std::vector<double> agg_utilities(n_pub * n_agg);
  for (int i = 0; i < n_pub; ++i) {
    for (int j = 0; j < n_agg; ++j) {
      auto [u_pub, u_agg] = Payoff(i, j, p);
      pub_utilities[i * n_agg + j] = u_pub;
      agg_utilities[i * n_agg + j] = u_agg;
    }
  }
  return std::shared_ptr<const Game>(new MatrixGame(
      kGameType, gp, kPublisherActions, kAggregatorActions,
      std::move(pub_utilities), std::move(agg_utilities)));
}

REGISTER_SPIEL_GAME(kGameType, Factory);

RegisterSingleTensorObserver single_tensor(kGameType.short_name);

}  // namespace
}  // namespace scaffold_deception
}  // namespace open_spiel
