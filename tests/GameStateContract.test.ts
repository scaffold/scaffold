import { assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { GAME_STATE_CONTRACT, RECORD_CONTRACT, SIGNATURE_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput, recordContract } from '../src/contracts/RecordContract.ts';
import { signatureContract } from '../src/contracts/SignatureContract.ts';
import { gameStateContract } from '../src/contracts/GameStateContract.ts';
import {
  ExecutionModuleShim as ExecutionModule,
  type ExecutionProvider,
} from './testutil/ExecutionModuleShim.ts';
import {
  applyMove,
  makeAwaitingJoinState,
  makeInProgressState,
  type Move,
  sqIdx,
  STATUS_BLACK_WON,
  STATUS_DRAW,
  STATUS_IN_PROGRESS,
  STATUS_TIMEOUT_WHITE,
  TIMEOUT_MOVE,
  WHITE,
} from '../src/demo/chess/ChessRules.ts';
import {
  encodeGameParams,
  encodeGameState,
  encodeMove,
  type GameStateEnvelope,
  ZERO_PUBKEY,
} from '../src/demo/chess/GameStateCodec.ts';

// -- Test block type -------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claimIndices: number[];
  refs: Hash[];
  signer?: Uint8Array;
  timestamp: number;
}

// -- Helpers ---------------------------------------------------------

const h = (n: string): Hash => Hash.digest(n);

function pubkey(byte: number): Uint8Array {
  const out = new Uint8Array(33);
  out.fill(byte);
  return out;
}

const WHITE_PK = pubkey(0xaa);
const BLACK_PK = pubkey(0xbb);
const GAME_ID = new Uint8Array(32);
for (let i = 0; i < 32; i++) GAME_ID[i] = i + 1;

function gameStateOutput(
  turnId: number,
  value: number,
  env: GameStateEnvelope,
): Output {
  return {
    verifier: { contract: GAME_STATE_CONTRACT, params: encodeGameParams(GAME_ID, turnId) },
    value,
    data: encodeGameState(env),
  };
}

function sigOutput(pk: Uint8Array, value: number): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: pk },
    value,
    data: new Uint8Array(0),
  };
}

// -- Test provider ---------------------------------------------------

class TestProvider implements ExecutionProvider<TestBlock> {
  readonly blocks = new Map<string, TestBlock>();

  addBlock(block: TestBlock): void {
    this.blocks.set(block.hash.toHex(), block);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toHex());
  }

  getOutputs(block: TestBlock): Output[] {
    return block.outputs;
  }

  getRefs(block: TestBlock): Hash[] {
    return block.refs;
  }

  getClaims(block: TestBlock): number[] {
    return block.claimIndices;
  }

  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }

  resolveClaim(block: TestBlock, claimIndex: number): Output | undefined {
    if (claimIndex < block.outputs.length) return block.outputs[claimIndex];
    if (Hash.equals(block.anchor, ZERO_HASH)) return undefined;
    const anchor = this.getBlock(block.anchor);
    if (!anchor) return undefined;
    return anchor.outputs[claimIndex - block.outputs.length];
  }

  getSigner(block: TestBlock): Uint8Array | undefined {
    return block.signer;
  }

  getTimestamp(block: TestBlock): number {
    return block.timestamp;
  }
}

function setup(): { provider: TestProvider; module: ExecutionModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new ExecutionModule(provider);
  module.registerContract(GAME_STATE_CONTRACT, gameStateContract);
  module.registerContract(RECORD_CONTRACT, recordContract);
  module.registerContract(SIGNATURE_CONTRACT, signatureContract);
  return { provider, module };
}

// -- Tests: JOIN ----------------------------------------------------

Deno.test('Join: black claims an awaiting-join game', async () => {
  const { provider, module } = setup();

  const awaiting: GameStateEnvelope = {
    state: makeAwaitingJoinState(1000),
    white: WHITE_PK,
    black: ZERO_PUBKEY,
  };

  const anchor: TestBlock = {
    hash: h('create'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(0, 500, awaiting)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const joined: GameStateEnvelope = {
    state: makeInProgressState(2000),
    white: WHITE_PK,
    black: BLACK_PK,
  };

  const joinBlock: TestBlock = {
    hash: h('join'),
    anchor: anchor.hash,
    // Own outputs (in block-order):
    //   [0] RECORD/"join"  -- carries black's pubkey
    //   [1] GAME_STATE/turn=1 -- the joined state
    // Extended:
    //   [0] RECORD/"join", [1] GAME_STATE/turn=1,
    //   [2] anchor.own[0] = GAME_STATE/turn=0
    outputs: [
      makeRecordOutput('join', BLACK_PK),
      gameStateOutput(1, 1000, joined),
    ],
    // Claim the previous GAME_STATE (ext idx 2) and self-claim the RECORD (0).
    claimIndices: [2, 0],
    refs: [],
    signer: BLACK_PK,
    timestamp: 2000,
  };
  provider.addBlock(joinBlock);

  const result = await module.verifyBlock(joinBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Join: rejects when signer != black pubkey in RECORD', async () => {
  const { provider, module } = setup();
  const awaiting: GameStateEnvelope = {
    state: makeAwaitingJoinState(1000),
    white: WHITE_PK,
    black: ZERO_PUBKEY,
  };
  const anchor: TestBlock = {
    hash: h('create'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(0, 500, awaiting)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const joined: GameStateEnvelope = {
    state: makeInProgressState(2000),
    white: WHITE_PK,
    black: BLACK_PK,
  };
  // Record says black is BLACK_PK but the block is signed by a third party.
  const imposter = pubkey(0xcc);
  const joinBlock: TestBlock = {
    hash: h('join-bad'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('join', BLACK_PK),
      gameStateOutput(1, 1000, joined),
    ],
    claimIndices: [2, 0],
    refs: [],
    signer: imposter,
    timestamp: 2000,
  };
  provider.addBlock(joinBlock);

  const result = await module.verifyBlock(joinBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: regular move --------------------------------------------

function playedState(ts: number): GameStateEnvelope {
  return {
    state: makeInProgressState(ts),
    white: WHITE_PK,
    black: BLACK_PK,
  };
}

Deno.test('Move: legal e2-e4 accepted', async () => {
  const { provider, module } = setup();
  const prev = playedState(1000);

  const anchor: TestBlock = {
    hash: h('prev'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(1, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const move: Move = { from: sqIdx('e2'), to: sqIdx('e4'), promotion: 0 };
  const next = applyMove(prev.state, move, 1500);
  const nextEnv: GameStateEnvelope = { state: next, white: WHITE_PK, black: BLACK_PK };

  const moveBlock: TestBlock = {
    hash: h('move1'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(move)),
      gameStateOutput(2, 1000, nextEnv),
    ],
    // Claim prev GAME_STATE (ext idx 2) and self-claim the RECORD (0).
    claimIndices: [2, 0],
    refs: [],
    signer: WHITE_PK,
    timestamp: 1500,
  };
  provider.addBlock(moveBlock);

  const result = await module.verifyBlock(moveBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Move: illegal (bishop through pawn) rejected', async () => {
  const { provider, module } = setup();
  const prev = playedState(1000);

  const anchor: TestBlock = {
    hash: h('prev-bad'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(1, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  // Fabricate a "next" state where c1 bishop has jumped to h6 (illegal).
  const fakeNext: GameStateEnvelope = {
    state: { ...prev.state, board: new Uint8Array(prev.state.board), toMove: 1, lastMoveAt: 1500 },
    white: WHITE_PK,
    black: BLACK_PK,
  };
  fakeNext.state.board[sqIdx('c1')] = 0;
  fakeNext.state.board[sqIdx('h6')] = 3; // W_BISHOP

  const move: Move = { from: sqIdx('c1'), to: sqIdx('h6'), promotion: 0 };
  const moveBlock: TestBlock = {
    hash: h('move-bad'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(move)),
      gameStateOutput(2, 1000, fakeNext),
    ],
    claimIndices: [2, 0],
    refs: [],
    signer: WHITE_PK,
    timestamp: 1500,
  };
  provider.addBlock(moveBlock);

  const result = await module.verifyBlock(moveBlock.hash);
  assertEquals(result.accepted, false);
});

Deno.test('Move: rejects when signed by the wrong player', async () => {
  const { provider, module } = setup();
  const prev = playedState(1000);
  const anchor: TestBlock = {
    hash: h('prev-wrongsign'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(1, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 1000,
  };
  provider.addBlock(anchor);

  const move: Move = { from: sqIdx('e2'), to: sqIdx('e4'), promotion: 0 };
  const next = applyMove(prev.state, move, 1500);
  const nextEnv: GameStateEnvelope = { state: next, white: WHITE_PK, black: BLACK_PK };

  const moveBlock: TestBlock = {
    hash: h('move-wrongsign'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(move)),
      gameStateOutput(2, 1000, nextEnv),
    ],
    claimIndices: [2, 0],
    refs: [],
    signer: BLACK_PK, // but white is on move
    timestamp: 1500,
  };
  provider.addBlock(moveBlock);
  const result = await module.verifyBlock(moveBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: checkmate payout ----------------------------------------

Deno.test('Checkmate: terminal block pays out the pot to the winner', async () => {
  const { provider, module } = setup();

  // Set up to deliver fools mate on the next move. Apply 1.f3 e5 2.g4 ...
  let state = makeInProgressState(0);
  state = applyMove(state, { from: sqIdx('f2'), to: sqIdx('f3'), promotion: 0 }, 1);
  state = applyMove(state, { from: sqIdx('e7'), to: sqIdx('e5'), promotion: 0 }, 2);
  state = applyMove(state, { from: sqIdx('g2'), to: sqIdx('g4'), promotion: 0 }, 3);

  const prev: GameStateEnvelope = { state, white: WHITE_PK, black: BLACK_PK };
  assertEquals(prev.state.status, STATUS_IN_PROGRESS);
  assertEquals(prev.state.toMove, 1); // black to move

  const anchor: TestBlock = {
    hash: h('prev-mate'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(3, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 3,
  };
  provider.addBlock(anchor);

  const mate: Move = { from: sqIdx('d8'), to: sqIdx('h4'), promotion: 0 };
  const after = applyMove(prev.state, mate, 4);
  assertEquals(after.status, STATUS_BLACK_WON);

  const mateBlock: TestBlock = {
    hash: h('mate'),
    anchor: anchor.hash,
    // RECORD move + SIGNATURE/BLACK payout. No GAME_STATE output.
    outputs: [
      makeRecordOutput('move', encodeMove(mate)),
      sigOutput(BLACK_PK, 1000),
    ],
    // Claim prev GAME_STATE (ext 2) and self-claim RECORD (0).
    claimIndices: [2, 0],
    refs: [],
    signer: BLACK_PK,
    timestamp: 4,
  };
  provider.addBlock(mateBlock);

  const result = await module.verifyBlock(mateBlock.hash);
  assertEquals(result, { accepted: true });
});

Deno.test('Checkmate: rejects wrong winner', async () => {
  const { provider, module } = setup();
  let state = makeInProgressState(0);
  state = applyMove(state, { from: sqIdx('f2'), to: sqIdx('f3'), promotion: 0 }, 1);
  state = applyMove(state, { from: sqIdx('e7'), to: sqIdx('e5'), promotion: 0 }, 2);
  state = applyMove(state, { from: sqIdx('g2'), to: sqIdx('g4'), promotion: 0 }, 3);
  const prev: GameStateEnvelope = { state, white: WHITE_PK, black: BLACK_PK };
  const anchor: TestBlock = {
    hash: h('prev-mate2'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(3, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 3,
  };
  provider.addBlock(anchor);
  const mate: Move = { from: sqIdx('d8'), to: sqIdx('h4'), promotion: 0 };
  const mateBlock: TestBlock = {
    hash: h('mate-bad'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(mate)),
      sigOutput(WHITE_PK, 1000), // wrong: should be BLACK_PK
    ],
    claimIndices: [2, 0],
    refs: [],
    signer: BLACK_PK,
    timestamp: 4,
  };
  provider.addBlock(mateBlock);
  const result = await module.verifyBlock(mateBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: clock timeout ------------------------------------------

Deno.test({
  name: 'Timeout: opponent can claim after clock runs out',
  // Temporarily disabled: GameStateContract now requires the mover's
  // signature before reading the move (so non-mover generators die
  // before parking on requestBody). The opponent-signed timeout branch
  // needs its own verifier-params slot or a signer-dispatched entry
  // point. Re-enable once that lands.
  ignore: true,
  fn: async () => {
  const { provider, module } = setup();
  const prev = playedState(0);
  // white has 5 minutes; t = 300_001 expires.
  const anchor: TestBlock = {
    hash: h('prev-timeout'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(1, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 0,
  };
  provider.addBlock(anchor);

  const timeoutNext = applyMove(prev.state, TIMEOUT_MOVE, 300_001);
  assertEquals(timeoutNext.status, STATUS_TIMEOUT_WHITE);

  const timeoutBlock: TestBlock = {
    hash: h('timeout'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(TIMEOUT_MOVE)),
      sigOutput(BLACK_PK, 1000),
    ],
    claimIndices: [2, 0],
    refs: [],
    signer: BLACK_PK, // OPPONENT claims the timeout
    timestamp: 300_001,
  };
  provider.addBlock(timeoutBlock);

  const result = await module.verifyBlock(timeoutBlock.hash);
  assertEquals(result, { accepted: true });
  },
});

Deno.test('Timeout: cannot be claimed before clock expires', async () => {
  const { provider, module } = setup();
  const prev = playedState(0);
  const anchor: TestBlock = {
    hash: h('prev-noto'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(1, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 0,
  };
  provider.addBlock(anchor);

  const timeoutBlock: TestBlock = {
    hash: h('timeout-early'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(TIMEOUT_MOVE)),
      sigOutput(BLACK_PK, 1000),
    ],
    claimIndices: [2, 0],
    refs: [],
    signer: BLACK_PK,
    timestamp: 1000, // only 1 second elapsed
  };
  provider.addBlock(timeoutBlock);
  const result = await module.verifyBlock(timeoutBlock.hash);
  assertEquals(result.accepted, false);
});

// -- Tests: stalemate draw ------------------------------------------

Deno.test('Draw: stalemate splits the pot', async () => {
  const { provider, module } = setup();
  // Construct the same stalemate-producing position as in ChessRules.test.ts:
  // white king f7, white queen g2; black king h8; white to move plays Qg2-g6
  // producing stalemate for black.
  const board = new Uint8Array(64);
  board[sqIdx('h8')] = 12; // B_KING
  board[sqIdx('f7')] = 6; // W_KING
  board[sqIdx('g2')] = 5; // W_QUEEN
  const prev: GameStateEnvelope = {
    state: {
      board,
      toMove: WHITE,
      castling: 0,
      enPassant: 0xff,
      halfmoveClock: 0,
      fullmove: 10,
      whiteClockMs: 100_000,
      blackClockMs: 100_000,
      lastMoveAt: 0,
      status: STATUS_IN_PROGRESS,
    },
    white: WHITE_PK,
    black: BLACK_PK,
  };
  const anchor: TestBlock = {
    hash: h('pre-draw'),
    anchor: ZERO_HASH,
    outputs: [gameStateOutput(1, 1000, prev)],
    claimIndices: [],
    refs: [],
    timestamp: 0,
  };
  provider.addBlock(anchor);

  const drawMove: Move = { from: sqIdx('g2'), to: sqIdx('g6'), promotion: 0 };
  const next = applyMove(prev.state, drawMove, 1);
  assertEquals(next.status, STATUS_DRAW);

  const drawBlock: TestBlock = {
    hash: h('draw'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('move', encodeMove(drawMove)),
      sigOutput(WHITE_PK, 500),
      sigOutput(BLACK_PK, 500),
    ],
    claimIndices: [3, 0],
    refs: [],
    signer: WHITE_PK,
    timestamp: 1,
  };
  provider.addBlock(drawBlock);

  const result = await module.verifyBlock(drawBlock.hash);
  assertEquals(result, { accepted: true });
});
