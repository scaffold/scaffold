import Context from './Context.ts';
import secp from './util/secp.ts';
import { hex2bin } from './util/hex.ts';
import { makeDefaultConfig } from './Config.ts';
import Hash, { ZERO_HASH } from './util/Hash.ts';
import { AccountContractParams } from './messages.ts';
import BlockBuilder from './BlockBuilder.ts';
import { accountHash } from './constants.ts';
import BlockService from './BlockService.ts';
import { bin2hex } from './util/hex.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import FactService from './FactService.ts';
import NodeService from './NodeService.ts';
import NullStorageProvider from '../plugins/NullStorageProvider.ts';
import { log } from '../deps.ts';
import { EMPTY_ARR } from './util/buffer.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';

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

const generatedGenesisData = createGenesisBlock(initAccounts).data;
// console.log('Genesis block hex:', bin2hex(generatedGenesisData));
export const sharedGenesisData = hex2bin(
  '53424c050000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000853424c00000000000000000000000000000000000000000066726f6e74696572020014060214000253424c000000000000000000000000000000000000000000006163636f756e744442024148e8772a0a4ba2b8b4da9b609d224fd82b3cee0e7ea669ee6d7c306d7678e980897a000253424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c67980897a000453424c000000000000000000000000000000000000000000006163636f756e744442022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b80897a0006000c00000000000000a2b0f1c1a7631c368ddf2c5c88b11fa4c7b2eb3f9adaa8bb6d1bd5f591e7c5ef48ad8869be5e792ee28992215730b1fc13bee20ccde705f3ed5fbb3e07b9d005bf4412ca681800',
);
if (sharedGenesisData.byteLength !== generatedGenesisData.byteLength) {
  console.log('Genesis block hex:', bin2hex(generatedGenesisData));
  throw new Error(
    `Shared genesis data isn't the right length! Please update it.`,
  );
}

export default class GenesisService {
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
      console.log('Genesis block hex:', bin2hex(generatedGenesisData));
      throw err;
    }
  }

  public getTotalCoins() {
    return (1n << 62n);
  }
}
