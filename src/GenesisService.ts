import { Context } from './Context.ts';
import { secp } from './util/secp.ts';
import { hex2bin } from './util/hex.ts';
import { makeDefaultConfig } from './Config.ts';
import { Hash, ZERO_HASH } from './util/Hash.ts';
import { AccountContractParams, Block } from './messages.ts';
import { BlockBuilder } from './BlockBuilder.ts';
import { accountHash } from './constants.ts';
import { BlockService } from './BlockService.ts';
import { bin2hex } from './util/hex.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { PeerManager } from './PeerManager.ts';
import { NullStorageProvider } from '../plugins/NullStorageProvider.ts';
import * as log from '@std/log';
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
  '022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b', // arc client, ?pk=b5ccda5181d72697977d206465ef8f254dd8cc66c084bef0f5260c5de7332bce
  '028119e5daeb7011dd40caa5e6f8e01992f6c5d3369034901f8386a755ac360d03', // arc client, ?pk=d2ab40eb2e7d91ebd426f964dda2c8cf7417d47e86104209116505962dbaace9
  '024503dea6805b6e180a7089e6661661805038616441871a16b35c7765b1c2b7f6', // arc client, ?pk=dd70b6b4a33d236ece4d8373051bb19a9960d5f8e923c57bb457af0262b5670b
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
  });

  const block = ctx.get(BlockBuilder).buildBlock([{
    frontierVote: ZERO_BLOCK,

    // I forget what the pros/cons of making the genesis block be big or small
    // Let's make it small, I think that is one less edge case
    // frontierLevel: NUM_FRONTIER_LEVELS - 1,
    frontierLevel: 0,
  }], false);

  let groupIdx = 0;
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

  const data = ctx.get(FactService).compose(block, Block, FactType.Block);

  if (ctx.destruct() instanceof Promise) {
    throw new Error(`We should keep this method sync`);
  }

  return data;
};

export const sharedGenesisData = hex2bin(
  '53424c04000000000000000000000000000000000000000000000000000000000000000000000c53424c00000000000000000000000000000000000000000066726f6e74696572020002140c0000000000000253424c000000000000000000000000000000000000000000006163636f756e744442024148e8772a0a4ba2b8b4da9b609d224fd82b3cee0e7ea669ee6d7c306d7678e90680841e000053424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c6790680841e000253424c000000000000000000000000000000000000000000006163636f756e744442022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b0680841e000453424c000000000000000000000000000000000000000000006163636f756e744442028119e5daeb7011dd40caa5e6f8e01992f6c5d3369034901f8386a755ac360d030680841e000653424c000000000000000000000000000000000000000000006163636f756e744442024503dea6805b6e180a7089e6661661805038616441871a16b35c7765b1c2b7f60680841e0008000e0000000000000000bcc0b7808265a5c78e9751c4961b8118bada10f9e6b46bd349ea108180ec0f1e33d2cc0dbc49485f6abffa3bb68f029aff14ca8bdda9be4d03c65ba083e725e51f1edfd9815b01',
);

setTimeout(() => {
  const generatedGenesisData = createGenesisBlock(initAccounts);
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
        bin2hex(createGenesisBlock(initAccounts)),
      );
      throw err;
    }
  }

  public getGenesisBlock() {
    const match = this.ctx.get(FactService)
      .hackyGetBlocksMatching((x) => x.source === FactSource.Genesis);
    if (match.length !== 1) {
      throw new Error(`Not exactly one genesis block!`);
    }
    return match[0];
  }

  public getTotalCoins() {
    return (1n << 62n);
  }
}
