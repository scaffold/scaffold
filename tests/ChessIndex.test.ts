import { assert, assertEquals } from '@std/assert';
import { composeGenesisPacket } from '../src/core/Packet.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { secp } from '../src/util/secp.ts';
import { ChessGame } from '../src/demo/chess/ChessGame.ts';
import { ChessIndex } from '../src/demo/chess/ChessIndex.ts';
import { BalanceIndex } from '../src/demo/chess/BalanceIndex.ts';
import { Hash } from '../src/util/Hash.ts';
import { GAME_STATE_CONTRACT, SIGNATURE_CONTRACT } from '../src/core/Block.ts';

function makeNode(bal: number) {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const { block: genesis } = composeGenesisPacket([makeSignatureOutput(pub, bal)]);
  const scaffold = new Scaffold({
    privateKey: priv,
    genesis,
    enablePiggyback: false,
    // Disable generation for chess entirely -- the wrapper drives block
    // construction directly via put(). Leaves aggregation + collateral
    // generation alone.
    enableGeneration: (h: Hash) =>
      !Hash.equals(h, GAME_STATE_CONTRACT) && !Hash.equals(h, SIGNATURE_CONTRACT),
  });
  return { scaffold, pub };
}

Deno.test('BalanceIndex: initial free balance matches genesis UTXO', () => {
  const { scaffold, pub } = makeNode(1234);
  const bi = new BalanceIndex(scaffold);
  const b = bi.getBalance(pub);
  assertEquals(b.free, 1234);
  assertEquals(b.locked, 0);
  bi.close();
});

Deno.test('BalanceIndex: creating a game moves value to locked', async () => {
  const { scaffold, pub } = makeNode(1000);
  const chess = new ChessGame(scaffold);
  const bi = new BalanceIndex(scaffold);

  chess.createGame(200);
  await new Promise((r) => setTimeout(r, 20));

  const b = bi.getBalance(pub);
  assertEquals(b.locked, 200);
  assertEquals(b.free, 800);
  bi.close();
  await scaffold.close();
});

Deno.test('ChessIndex: lists an awaiting-join game after createGame', async () => {
  const { scaffold } = makeNode(1000);
  const chess = new ChessGame(scaffold);
  const idx = new ChessIndex(scaffold, chess);

  const gameId = chess.createGame(200);
  await new Promise((r) => setTimeout(r, 20));

  const list = idx.list();
  assertEquals(list.length, 1);
  assertEquals(list[0].turnId, 0);
  const fetched = idx.get(gameId);
  assert(fetched);
  assertEquals(fetched!.value, 200);

  const open = idx.openGames();
  assertEquals(open.length, 1);

  idx.close();
  await scaffold.close();
});

Deno.test('ChessIndex: onChange fires after canonicality flip', async () => {
  const { scaffold } = makeNode(1000);
  const chess = new ChessGame(scaffold);
  const idx = new ChessIndex(scaffold, chess);

  let fired = 0;
  idx.onChange(() => fired++);

  chess.createGame(200);
  await new Promise((r) => setTimeout(r, 20));

  assert(fired > 0, 'onChange fires after create');
  idx.close();
  await scaffold.close();
});
