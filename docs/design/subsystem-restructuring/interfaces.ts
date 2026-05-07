// docs/design/subsystem-restructuring/interfaces.ts
//
// Proposed subsystem interfaces for `src/core/`.
//
// This is a design sketch, not production code. It is intentionally type-checked
// (Deno will compile it) so we can iterate on shapes without losing type safety,
// but it does not import from `src/core/` because we want to be able to evolve
// names freely. Where we want to refer to existing types, we re-declare a stub
// here with `// (matches src/core/Block.ts)` so the relationship is clear.
//
// ---------------------------------------------------------------------------
// Naming convention -- *inverted from current `src/core/`*
// ---------------------------------------------------------------------------
//
// Today: `XxxProvider` means "what the host provides TO module Xxx"
//        e.g. `AnchoringProvider.getBlock(hash)` -- host provides this to AnchoringModule.
//
// Proposed:
//   `XxxAdapter`  -- what the host provides TO subsystem Xxx (today's `Provider`)
//   `XxxProvider` -- what subsystem Xxx provides OUTWARD (its public API)
//   `XxxFactory`  -- constructs an `XxxProvider` given an `XxxAdapter`
//
// This matches the more common interpretation of "provider" (a thing that
// provides a service) and makes wiring explicit. If we adopt this layout, all
// existing `XxxProvider` interfaces in `src/core/` get renamed to `XxxAdapter`
// in one mechanical pass.
//
// ---------------------------------------------------------------------------

// -- Shared types (stubs of real types in src/core/) -----------------------

type Hash = unknown; // src/util/Hash.ts
type Ref = Hash;     // canonical reference to a Block or Draft (Node.ts)

interface Block { /* matches src/core/Block.ts */ }
interface Draft { /* matches src/core/Draft.ts */ }
interface ContractEnv { /* matches src/core/ContractEnv.ts -- the unit of work for the executor */ }

// A vertex in the DAG -- Block or Draft. Both satisfy this surface today
// (see src/core/Node.ts). Reads-only here on purpose; subsystems write back
// through their adapter, never by mutating Node directly.
interface Node {
  readonly ref: Ref;
  readonly anchor: Ref;
  readonly aggregates: readonly Ref[];
  readonly weight: number;
  readonly canonical: boolean;
}

// =========================================================================
// Executor -- generation and verification tasks
// =========================================================================
//
// Today this corresponds to: ExecutionQueueModule, ContractHost,
// ContractVerificationModule, BlockVerificationModule, the Generating/
// VerifyingEnv pair, WasmStore, and the output handler registry.
//
// The executor is a priority queue of contract tasks. The host (Store) tells
// it what tasks exist; the executor pulls them in priority order and runs
// them. Priority can change over time -- the adapter is queried, not pushed.

interface ExecutorAdapter {
  // Re-evaluated by the queue when deciding what to run next.
  getPriority(task: ContractEnv): number;
}

interface ExecutorProvider {
  // OPEN: Joel's sketch had `execute(task) -> Promise<boolean>`. Two readings:
  //   (a) one-shot run-this-now (synchronous-style, caller awaits the result)
  //   (b) enqueue-and-eventually-run (returns a handle/promise of completion)
  // Today's queue is (b). Going with (b) here; rename if (a) is intended.
  enqueue(task: ContractEnv): Promise<boolean>;
}

interface ExecutorFactory {
  new (adapter: ExecutorAdapter): ExecutorProvider;
}

// =========================================================================
// Forest -- weight propagation and graph sampling
// =========================================================================
//
// Today: SamplingModule + NodeWeightsModule. Possibly TrustModule (TBD --
// see categorization.md, item 4).
//
// Forest produces a weight for each node and routes verification priority
// based on that weight. The "sampling" half (which subtree to verify next)
// and the "weight" half (how heavy is each node) are intertwined: weight
// drives sampling priority, and verification results feed back into weight.

interface ForestAdapter {
  // OPEN: what is `priority` here for? Joel's sketch passes priority into
  // get() -- I read this as a hint to the host's storage layer ("don't bother
  // fetching low-priority refs"). If so, name it `minPriority` and document.
  get(ref: Ref, priority: number): Node | undefined;

  // Cost function used when assigning weight (e.g., verification cost).
  measure(ref: Ref): number;

  // Forest writes the propagated weight back through the adapter so the
  // storage layer (Store) is the single source of truth for node state.
  updateWeight(ref: Ref, weight: number): void;
}

interface ForestProvider {
  // Triggers re-propagation starting at `ref`. Called by Store when a node's
  // structure changes (new block ingested, draft updated, ancestor verified).
  update(ref: Ref): void;
}

interface ForestFactory {
  new (adapter: ForestAdapter): ForestProvider;
}

// =========================================================================
// Canonicality -- conflict resolution and canonicality propagation
// =========================================================================
//
// Today: ConsensusModule + OutputClaimModule + AnchoringModule.
//
// Canonicality decides which blocks/drafts are part of the canonical chain
// given current weight + claim conflicts. It does not compute weight (that
// is Forest's job); it only consumes it. Output-claim resolution is in here
// because claim conflicts are the input to canonicality decisions.

interface CanonicalityAdapter {
  get(ref: Ref): Node | undefined;
  updateCanonicality(ref: Ref, isCanonical: boolean): void;

  // OPEN: canonicality needs effective weight to break conflicts. Either:
  //   (a) Forest exposes a query, and Store wires Forest's query into
  //       Canonicality's adapter, or
  //   (b) `Node.weight` already carries it (current sketch).
  // Going with (b) for now; revisit when wiring up the Store factory.
}

interface CanonicalityProvider {
  // Triggered when something that affects canonicality changes (a new block,
  // a weight update, a new claim conflict).
  update(ref: Ref): void;
}

interface CanonicalityFactory {
  new (adapter: CanonicalityAdapter): CanonicalityProvider;
}

// =========================================================================
// Construction -- build drafts and blocks
// =========================================================================
//
// Today: BlockBuilderModule + DraftManager + Generator + AnchorSelection
// (and the type/validation halves of BlockCreationModule).
//
// Construction owns "the draft becomes a block" pipeline: anchor selection,
// claim-index lowering, signing. The host hands it a draft; it hands back a
// finished block via the adapter callback.

interface ConstructionAdapter {
  // Called when Construction has finished a draft and produced a block.
  // Store routes this into ingest(block).
  create(block: Block): void;

  // OPEN: Construction also reads from the graph (anchor selection needs
  // ancestor blocks). Add `get(ref)` here, or hand it via a separate
  // adapter? Leaning toward including it on the same adapter for symmetry.
  get(ref: Ref): Node | undefined;
}

interface ConstructionProvider {
  // Submit a draft to be solidified into a block. Eventually fires the
  // adapter's `create(block)` callback (or never, if the draft can't be
  // solidified -- in which case Construction may emit it back as a draft
  // update; see `update(draft)` on Store).
  build(draft: Draft): void;
}

interface ConstructionFactory {
  new (adapter: ConstructionAdapter): ConstructionProvider;
}

// =========================================================================
// Store -- the assembly of the four subsystems above
// =========================================================================
//
// Store is the only thing the outside world (FetchManager, PutManager,
// gossip, demo apps) talks to. It owns the block/draft storage, threads
// adapter views of that storage into each child, and wires their callbacks
// back into itself.
//
// Today this corresponds to: Coordinator + ProtocolContext + the storage
// halves of BlockStore/DraftStore.

interface StoreAdapter {
  // Emit a finished block outward (Store has accepted it; downstream
  // consumers like gossip should see it).
  create(block: Block): void;

  // Emit a draft update outward (a draft was created/modified/cancelled).
  update(draft: Draft): void;
}

interface StoreProvider {
  // The two entry points the outside world uses.
  ingest(block: Block): void;
  build(draft: Draft): void;
}

interface StoreFactory {
  // The Store factory builds the four child providers internally. The
  // factories for the children are passed in so we can swap implementations
  // (real, stub, instrumented).
  new (
    adapter: StoreAdapter,
    factories: {
      executor: ExecutorFactory;
      forest: ForestFactory;
      canonicality: CanonicalityFactory;
      construction: ConstructionFactory;
    },
  ): StoreProvider;
}

// =========================================================================
// Wiring sketch
// =========================================================================
//
// What the inside of `new StoreFactory(adapter, factories)` looks like.
// This is illustrative: the goal is to make sure the adapter shapes above
// are sufficient to wire up the system without leakage.
//
//   class Store implements StoreProvider {
//     constructor(outer: StoreAdapter, f: { ... }) {
//       const graph = new GraphStore();  // owns Block + Draft storage
//
//       // Each child gets an adapter view backed by `graph`. Writes by
//       // children land in `graph`; reads by other children see them.
//       const executor = new f.executor({
//         getPriority: (task) => priorityFor(graph, task),
//       });
//
//       const forest = new f.forest({
//         get: (ref, _) => graph.get(ref),
//         measure: (ref) => measureCost(graph, ref),
//         updateWeight: (ref, w) => {
//           graph.setWeight(ref, w);
//           canonicality.update(ref);  // weight change re-evaluates canonicality
//         },
//       });
//
//       const canonicality = new f.canonicality({
//         get: (ref) => graph.get(ref),
//         updateCanonicality: (ref, c) => {
//           graph.setCanonical(ref, c);
//           // canonicality change may unblock executor priorities, so re-poke
//         },
//       });
//
//       const construction = new f.construction({
//         get: (ref) => graph.get(ref),
//         create: (block) => {
//           this.ingest(block);  // route built blocks back through ingest
//           outer.create(block); // and out to the world
//         },
//       });
//
//       this.ingest = (block) => {
//         graph.put(block);
//         forest.update(block.ref);
//         canonicality.update(block.ref);
//         outer.create(block);
//       };
//
//       this.build = (draft) => {
//         graph.put(draft);
//         construction.build(draft);
//         outer.update(draft);
//       };
//     }
//   }
//
// Things this wiring sketch surfaces:
//
//   1. Forest -> Canonicality coupling. Weight updates need to re-trigger
//      canonicality. Either Store mediates (as above) or Forest holds a
//      direct ref to Canonicality. The factory layout above makes Store
//      the mediator.
//
//   2. Construction's `create(block)` is called for every built block, but
//      Store also exposes `ingest(block)` from outside. Built blocks need
//      to enter the graph the same way ingested blocks do, so we route
//      build output through ingest -- see `construction.create` callback.
//
//   3. Where does the Executor get its tasks? The sketch says `enqueue`
//      is called from outside, but in practice Canonicality (which decides
//      which subtree to verify) should be the one enqueueing. Open
//      question: does Canonicality get a handle to Executor, or does Store
//      mediate? Mediating preserves the one-adapter-per-child contract.
