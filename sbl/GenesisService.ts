import Context from '~/sbl/Context.ts';
import secp from '~/sbl/util/secp.ts';
import { hex2bin } from '~/sbl/util/hex.ts';
import { makeDefaultConfig } from '~/sbl/Config.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import { AccountContractParams } from '~/sbl/messages.ts';
import BlockBuilder from '~/sbl/BlockBuilder.ts';
import { accountHash } from '~/sbl/constants.ts';
import BlockService from '~/sbl/BlockService.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import { BlockFact, FactSource, FactType } from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import NullStorageProvider from '~/plugins/NullStorageProvider.ts';
import MockTimeProvider from '~/tests/MockTimeProvider.ts';

// bin2hex(secp.utils.randomPrivateKey())
const genesisPrivateKey = hex2bin(
  'bc62466caeb98dd6128cfb3d0eb990ba12837b44cd206047b579b1c26ba6e676',
);
const genesisPublicKey = secp.getPublicKey(genesisPrivateKey);

const initAccounts = [
  '4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784', // server
  '02c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c679', // chrome client
  '03c37af130a275a525cdd4a660e5d00a0e915c47d812984158fc2c6a2657ca449c', // arc client
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

    networkProviders: [],

    timeProvider: new MockTimeProvider(),
    storageProvider: new NullStorageProvider(),
    contractProviders: [],

    enableValidation: false,
  });

  const block = ctx.get(BlockBuilder).buildBlock({});
  block.inputs.push({ block_hash: ZERO_HASH, output_idx: 0 });
  for (const { publicKey, amount } of accounts) {
    block.outputs.push({
      verifier: {
        contract_hash: accountHash,
        params: AccountContractParams.encode({ public_key: publicKey }),
      },
      amount,
      detail: new Uint8Array(),
    });
  }
  return ctx.get(BlockService).create(block);
};

const generatedGenesisData = createGenesisBlock(initAccounts).data;
// console.log('Genesis block hex:', bin2hex(generatedGenesisData));
export const sharedGenesisData = hex2bin(
  '53424c0200000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000853424c00000000000000000000000000000000000000000066726f6e746965720200140602140053424c000000000000000000000000000000000000000000006163636f756e7442404b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a578480897a0053424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c67980897a0053424c000000000000000000000000000000000000000000006163636f756e74444203c37af130a275a525cdd4a660e5d00a0e915c47d812984158fc2c6a2657ca449c80897a000000003d6e207172d08f202915d9fe0f3ef670add06140c09ed2957f857f52453461c4206e92bc960b435c93e68c322c93536b18fff26cca328f0b4489be48425c3b7101',
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
      this.ctx.get(FactService).ingest(
        data,
        FactSource.Genesis,
        this.ctx.get(NodeService).getSelfNode(),
      );
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
