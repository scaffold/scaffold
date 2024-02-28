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
  '022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b', // arc client, ?pk=b5ccda5181d72697977d206465ef8f254dd8cc66c084bef0f5260c5de7332bce
  '028119e5daeb7011dd40caa5e6f8e01992f6c5d3369034901f8386a755ac360d03', // arc client, ?pkid=2
  '024503dea6805b6e180a7089e6661661805038616441871a16b35c7765b1c2b7f6', // arc client, ?pkid=3
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

  const data = ctx.get(FactService).compose(block, Block, FactType.Block);

  if (ctx.destruct() instanceof Promise) {
    throw new Error(`We should keep this method sync`);
  }

  return data;
};

export const sharedGenesisData = hex2bin(
  '53424c050000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000c53424c00000000000000000000000000000000000000000066726f6e7469657204fe030214060000000253424c000000000000000000000000000000000000000000006163636f756e744442024148e8772a0a4ba2b8b4da9b609d224fd82b3cee0e7ea669ee6d7c306d7678e90680841e000253424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c6790680841e000453424c000000000000000000000000000000000000000000006163636f756e744442022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b0680841e000653424c000000000000000000000000000000000000000000006163636f756e744442028119e5daeb7011dd40caa5e6f8e01992f6c5d3369034901f8386a755ac360d030680841e000853424c000000000000000000000000000000000000000000006163636f756e744442024503dea6805b6e180a7089e6661661805038616441871a16b35c7765b1c2b7f60680841e000a0010000000000000000000f4ccc9c5bc63bd7a381a86c1d5187be2ebbd297dbc9f10f68d09676255aebb10023fa509f6394620aacbf3dd62fa9cdec86205756031281c6ee10e843f7db1ddf4047bb4b68001',
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
