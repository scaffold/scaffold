import Context from '~/sbl/Context.ts';
import secp from '~/sbl/util/secp.ts';
import { hex2bin } from '~/sbl/util/hex.ts';
import { makeDefaultConfig } from '~/sbl/Config.ts';
import Hash from '~/sbl/util/Hash.ts';
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
  '02c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c679', // client
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

  return ctx.get(BlockBuilder).publish({
    // body: genesisPublicKey,
    outputs: accounts.map(({ publicKey, amount }) => ({
      verifier: {
        contract_hash: accountHash,
        params: AccountContractParams.encode({ public_key: publicKey }),
      },
      amount,
      detail: new Uint8Array(),
    })),
  }, 0);
};

const generatedGenesisData = createGenesisBlock(initAccounts).data;
// console.log('Genesis block hex:', bin2hex(generatedGenesisData));
export const sharedGenesisData = hex2bin(
  '53424c02000000000000000000000000000000000000000000000000000000000000000000000653424c000000000000000000000000000000000000000000006163636f756e7442404b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a578480897a0053424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c67980897a0053424c00000000000000000000000000000000000000000066726f6e7469657202001402140000006a4ea8fcb0b272b3eca257cd51fa1f364ce5198b5c770e3a6d4d4dd22dce20a060336dfaa9bb73ff09aa27ec315fee8dd332cc37bd7d7a87cb1f9ed752cc2ad701',
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
