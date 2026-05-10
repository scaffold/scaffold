// ChessGame is now generator-driven: the wrapper does NOT have joinGame /
// makeMove / claimTimeout methods. The only `put` entry point is
// createGame; everything else happens through the pending-prompt store +
// registerOutputHandler bridge. These tests exercise that end-to-end.

import { assert, assertEquals } from '@std/assert';
import { composeGenesisPacket } from '../src/core/Block.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { secp } from '../src/util/secp.ts';
import { ChessGame } from '../src/demo/chess/ChessGame.ts';
import { ZERO_PUBKEY } from '../src/demo/chess/GameStateCodec.ts';
import { type Block } from '../src/core/Block.ts';

function makePair(stakeEach: number) {
  const whitePriv = secp.utils.randomPrivateKey();
  const blackPriv = secp.utils.randomPrivateKey();
  const whitePub = secp.getPublicKey(whitePriv, true);
  const blackPub = secp.getPublicKey(blackPriv, true);

  const genesis = composeGenesisPacket([
    makeSignatureOutput(whitePub, stakeEach),
    makeSignatureOutput(blackPub, stakeEach),
  ]);

  const white = new Scaffold({ privateKey: whitePriv, genesis });
  const black = new Scaffold({ privateKey: blackPriv, genesis });

  const whiteChess = new ChessGame(white);
  const blackChess = new ChessGame(black);

  // Synchronous bidirectional block relay, dedupe via store.has.
  const forwarded = new Set<string>();
  const forward = (to: Scaffold, block: Block) => {
    const key = block.hash.toHex() + ':' + to.publicKeyHex;
    if (forwarded.has(key)) return;
    forwarded.add(key);
    if (!to.context.store.has(block.hash)) {
      to.context.processBlock(block);
    }
  };
  white.context.store.onAdded((block) => forward(black, block));
  black.context.store.onAdded((block) => forward(white, block));

  return { white, black, whiteChess, blackChess, whitePub, blackPub };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise((r) => setTimeout(r, 5));
  }
}

// -- Tests --------------------------------------------------------

Deno.test('ChessGame: single-node create publishes awaiting-join state', async () => {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const genesis = composeGenesisPacket([
    makeSignatureOutput(pub, 10_000),
  ]);
  const scaffold = new Scaffold({ privateKey: priv, genesis });
  const chess = new ChessGame(scaffold);

  const gameId = chess.createGame(200);
  await flush();

  const active = chess.getActive(gameId);
  assert(active);
  assertEquals(active!.turnId, 0);
  assertEquals(active!.value, 200);
  assertEquals(active!.state.state.status, 0);
  assertEquals(active!.state.black, ZERO_PUBKEY);

  await scaffold.close();
});

Deno.test('ChessGame: pending-prompt store creates/returns consistent prompts', () => {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const genesis = composeGenesisPacket([
    makeSignatureOutput(pub, 100),
  ]);
  const scaffold = new Scaffold({ privateKey: priv, genesis });
  const chess = new ChessGame(scaffold);

  const gameId = new Uint8Array(32);
  gameId[0] = 42;
  const p1 = chess.promptMove(gameId, 7);
  const p2 = chess.promptMove(gameId, 7);
  assert(p1 === p2, 'same key returns the same prompt');
  assertEquals(chess.listPending().length, 1);

  let fired = 0;
  const unsub = chess.onPendingChange(() => fired++);
  chess.cancelPrompt(p1.key);
  assertEquals(chess.listPending().length, 0);
  assert(fired > 0);
  unsub();
});

Deno.test('ChessGame: join flow via prompt drives generator end-to-end', async () => {
  const { white, black, whiteChess, blackChess, blackPub } = makePair(1000);

  // White introduces the game. DraftStrategy on BOTH nodes sees the
  // unclaimed GAME_STATE UTXO and starts a generator. The contract's
  // requestBody(RECORD/"join") parks on both until someone resolves.
  const gameId = whiteChess.createGame(200);
  await flush();

  // Black's UI "joins": posts a 'join' prompt on turn 0 and resolves it
  // with black's pubkey. Black's parked generator wakes, runs
  // sign(blackPub) which passes (matches black's signer
  // pubkey), and produces the join block. White's generator cannot
  // satisfy sign(blackPub) and stays parked.
  const joinPrompt = blackChess.promptJoin(gameId, 0);
  joinPrompt.resolve(blackPub);

  await flush();

  // Both nodes should now see the in-progress state at turn 1.
  for (const chess of [whiteChess, blackChess]) {
    const active = chess.getActive(gameId);
    assert(active, 'joined state visible');
    assertEquals(active!.turnId, 1);
    assertEquals(active!.state.state.status, 1 /* in_progress */);
    assertEquals(active!.value, 400);
  }

  await white.close();
  await black.close();
});
