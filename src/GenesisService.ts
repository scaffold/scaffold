import { Context } from './Context.ts';
import { secp } from './util/secp.ts';
import { hex2bin } from './util/hex.ts';
import { makeDefaultConfig } from './Config.ts';
import { Hash, ZERO_HASH } from './util/Hash.ts';
import { AccountContractParams } from './messages.ts';
import { BlockBuilder } from './BlockBuilder.ts';
import { accountHash } from './constants.ts';
import { BlockService } from './BlockService.ts';
import { bin2hex } from './util/hex.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { NodeService } from './NodeService.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import { log } from '../deps.ts';
import { EMPTY_ARR } from './util/buffer.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { NUM_FRONTIER_LEVELS } from './FrontierService2.ts';

// bin2hex(secp.utils.randomPrivateKey())
const genesisPrivateKey = hex2bin(
  'bc62466caeb98dd6128cfb3d0eb990ba12837b44cd206047b579b1c26ba6e676',
);
const genesisPublicKey = secp.getPublicKey(genesisPrivateKey);

const initAccounts = [
  '024148e8772a0a4ba2b8b4da9b609d224fd82b3cee0e7ea669ee6d7c306d7678e9', // server
  '02c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c679', // chrome client
  '022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b', // arc client
].map((publicKeyHex) => ({
  publicKey: hex2bin(publicKeyHex),
  amount: 1000000n,
}));

export const createGenesisBlock = (
  accounts: { publicKey: Uint8Array; amount: bigint }[],
) => {
  const ctx = new Context({
    ...makeDefaultConfig(),

    debugName: 'GenesisFactory',
    selfPrivateKey: genesisPrivateKey,

    logLevel: log.LogLevels.ERROR,

    networkProviders: [],

    storageProvider: new NullStorageProvider(),
    contractProviders: [],

    enableValidation: false,
  });

  const block = ctx.get(BlockBuilder).buildBlock([{
    frontierVote: ZERO_BLOCK,
    frontierLevel: NUM_FRONTIER_LEVELS - 1,
  }]);

  let groupIdx = 0;
  block.inputs.push({
    blockHash: ZERO_HASH,
    outputIdx: 0,
    groupIdx: groupIdx++,
  });
  block.bodies.push(EMPTY_ARR);

  for (const { publicKey, amount } of accounts) {
    block.outputs.push({
      verifier: {
        contractHash: accountHash,
        params: AccountContractParams.encode({ publicKey }),
      },
      amount,
      detail: new Uint8Array(),
      groupIdx: groupIdx++,
    });
    block.bodies.push(EMPTY_ARR);
  }

  return ctx.get(BlockService).create(block);
};

export const sharedGenesisData = hex2bin(
  '53424c050000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000853424c00000000000000000000000000000000000000000066726f6e7469657204fe03020a060000000253424c000000000000000000000000000000000000000000006163636f756e744442024148e8772a0a4ba2b8b4da9b609d224fd82b3cee0e7ea669ee6d7c306d7678e90640420f000253424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c6790640420f000453424c000000000000000000000000000000000000000000006163636f756e744442022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b0640420f0006000c00000000000000ac89fbafb163ab4c4b7180e73be13ca7619980bf5a8b386014cd8f1882ca873e81a50a7c06744da753e6a53a588fadfb44bfc16143054ee3f2bc084c431aab69880aa1da4b8a01',
);

setTimeout(() => {
  const generatedGenesisData = createGenesisBlock(initAccounts).data;
  // console.log('Genesis block hex:', bin2hex(generatedGenesisData));
  if (sharedGenesisData.byteLength !== generatedGenesisData.byteLength) {
    console.log('Genesis block hex:', bin2hex(generatedGenesisData));
    throw new Error(
      `Shared genesis data isn't the right length! Please update it.`,
    );
  }
}, 0);

export class GenesisService {
  constructor(private ctx: Context) {}

  public ingestGenesis(data: Uint8Array) {
    try {
      const fact = this.ctx.get(FactService).ingest(data, FactSource.Genesis);
      if (fact.type !== FactType.Block) {
        throw new Error(`Invalid fact type!`);
      }
      return fact;
    } catch (err) {
      console.error(err);
      console.error(`You probably need to update the genesis block data!`);
      console.log(
        'Genesis block hex:',
        bin2hex(createGenesisBlock(initAccounts).data),
      );
      throw err;
    }
  }

  public getGenesisBlock() {
    return this.ctx.get(FactService).hackyGetBlocksMatching((x) =>
      x.source === FactSource.Genesis
    )[0];
  }

  public getTotalCoins() {
    return (1n << 62n);
  }
}
