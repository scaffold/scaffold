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

// bin2hex(secp.utils.randomPrivateKey())
const genesisPrivateKey = hex2bin(
  'bc62466caeb98dd6128cfb3d0eb990ba12837b44cd206047b579b1c26ba6e676',
);
const genesisPublicKey = secp.getPublicKey(genesisPrivateKey);

const initAccounts = [
  '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784', // server
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

  const block = ctx.get(BlockBuilder).buildBlock([]);
  let groupIdx = 0;
  block.inputs.push({
    blockHash: ZERO_HASH,
    outputIdx: 0,
    groupIdx: groupIdx++,
  });
  for (const { publicKey, amount } of accounts) {
    block.outputs.push({
      verifier: {
        contract_hash: accountHash,
        params: AccountContractParams.encode({ publicKey }),
      },
      amount,
      detail: new Uint8Array(),
      groupIdx: groupIdx++,
    });
  }
  return ctx.get(BlockService).create(block);
};

const generatedGenesisData = createGenesisBlock(initAccounts).data;
// console.log('Genesis block hex:', bin2hex(generatedGenesisData));
export const sharedGenesisData = hex2bin(
  '53424c0500000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000853424c00000000000000000000000000000000000000000066726f6e746965720200140602140053424c000000000000000000000000000000000000000000006163636f756e7442404b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a578480897a0053424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c67980897a0053424c000000000000000000000000000000000000000000006163636f756e744442022dcf09ad49df279eaf9f3c2ecea2756e46676be80db075618dd372311c2e5f4b80897a000000f8b19783a063ae224bfdbd01e1473918bf2c4ac231a76ad994acec08c42a50ea78e6c221ecaf0d5682b6738952fa4aec97a404dc4f52b273d337b2c85f7acaf336917e8292c001',
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
      this.ctx.get(FactService).ingest(data, FactSource.Genesis);
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
