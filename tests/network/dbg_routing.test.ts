/**
 * Debug version of the failing 4-node routing test with tracing.
 */
import { PacketType } from '../../src/core/Packet.ts';
import { withNodeFields } from '../testutil/blockNodeFields.ts';
import { Hash } from '../../src/util/Hash.ts';
import { AtomSource, AtomType, Block, createGenesisBlock } from '../../src/core/Block.ts';
import { Output } from '../../src/core/BlockCreationModule.ts';
import { TestNetwork } from './TestNetwork.ts';

const V_LABEL = 'game-v';

function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    data: new Uint8Array([]),
  };
}

function makeBlock(
  name: string,
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claimIndices: number[] = [],
): Block {
  return withNodeFields({
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: [],
    claimIndices,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
  });
}

function makeRoutingGenesis(): Block {
  return createGenesisBlock([makeOutput(100, V_LABEL), makeOutput(100, V_LABEL)]);
}

Deno.test('DBG: 4-node routing trace', () => {
  const net = new TestNetwork();
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);
  net.addNode('D', false);

  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');
  net.connectPeers('C', 'D');

  const genesis = makeRoutingGenesis();
  net.broadcastGenesis(genesis);

  // Hook listeners on each node to log push actions
  for (const id of ['A', 'B', 'C', 'D']) {
    const n = net.getNode(id);
    n.routing.onPushAction((a) =>
      console.log(
        `[${id} push] block=${a.block.toHex().slice(0, 8)} -> peer=${a.peer} prio=${
          a.priority.toFixed(3)
        }`,
      )
    );
  }

  const claimD = makeBlock('claim-d', genesis, [makeOutput(50, V_LABEL)], 10, [1]);

  console.log('=== Phase 1: D self-originates claimD ===');
  net.getNode('D').receiveBlock(claimD, null);
  console.log(`D claim history count: ${net.getNode('D').gossip.totalClaimHistoryCount}`);

  console.log('=== D -> C ===');
  net.deliverFromPeer(claimD, 'C', 'D');
  console.log(`C has claimD: ${net.getNode('C').store.has(claimD.hash)}`);
  console.log(`C claim history count: ${net.getNode('C').gossip.totalClaimHistoryCount}`);

  console.log('=== C -> B ===');
  net.deliverFromPeer(claimD, 'B', 'C');
  console.log(`B has claimD: ${net.getNode('B').store.has(claimD.hash)}`);
  console.log(`B claim history count: ${net.getNode('B').gossip.totalClaimHistoryCount}`);

  console.log(`=== flush (pending=${net.pendingCount}) ===`);
  net.flush();

  console.log('=== Phase 2: A self-originates requestA ===');
  const requestA = makeBlock('request-a', genesis, [makeOutput(50, V_LABEL)], 10);
  net.getNode('A').receiveBlock(requestA, null);

  console.log('=== A -> B ===');
  net.deliverFromPeer(requestA, 'B', 'A');
  console.log(`B has requestA: ${net.getNode('B').store.has(requestA.hash)}`);

  console.log(`=== flush (pending=${net.pendingCount}) ===`);
  net.flush();

  console.log(`C has requestA: ${net.getNode('C').store.has(requestA.hash)}`);
  console.log(`D has requestA: ${net.getNode('D').store.has(requestA.hash)}`);
});
