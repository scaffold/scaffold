import Context from '~/sbl/Context.ts';
import secp from '~/sbl/util/secp.ts';
import { hex2bin } from '~/sbl/pathUtils.ts';
import { defaultConfig } from '~/sbl/Config.ts';
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

// bin2hex(secp.utils.randomPrivateKey())
const genesisPrivateKey = hex2bin(
  'bc62466caeb98dd6128cfb3d0eb990ba12837b44cd206047b579b1c26ba6e676',
);
const genesisPublicKey = secp.getPublicKey(genesisPrivateKey);

const initAccounts = [
  hex2bin('4b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a5784'), // server
  hex2bin('02c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c679'), // client
];

const createGenesisBlock = () => {
  const ctx = new Context({
    ...defaultConfig,

    debugName: 'SblClient',
    selfPrivateKey: genesisPrivateKey,

    networkProviders: [],

    storageProvider: new NullStorageProvider(),

    enableValidation: false,
  });

  return ctx.get(BlockBuilder).publish({
    body: genesisPublicKey,
    outputs: initAccounts.map((publicKey) => ({
      verifier: {
        contract_hash: accountHash,
        params: AccountContractParams.encode({ public_key: publicKey }),
      },
      amount: 1000000n,
      detail: new Uint8Array(),
    })),
  }, 0);
};

const generatedGenesisData = createGenesisBlock().data;
console.log('Genesis block hex:', bin2hex(generatedGenesisData));
const sharedGenesisData = hex2bin(
  '53424c0200000653424c000000000000000000000000000000000000000000006163636f756e7442404b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a578480897a0053424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c67980897a0053424c00000000000000000000000000000000000000000066726f6e74696572020014000000000000000000000000000000000000000000000000000000000000000000004203709e4ca7819f7e53b578454d5da4eb791fb3dc05f3bfa532af407ac14f055ff2deb59c8ded628c4937c2af864b44abd77e03d8b98a37cefcf62985c8befc86f52cafc9fa2a7651cc2cf8f6234a635f72d7d7bcce061a52f530d0d81f503af6dfbdc2dcb8bc4501',
);
if (sharedGenesisData.byteLength !== generatedGenesisData.byteLength) {
  throw new Error(
    `Shared genesis data isn't the right length! Please update it.`,
  );
}

export default class GenesisService {
  constructor(private ctx: Context) {
    try {
      ctx.get(FactService).ingest(
        sharedGenesisData,
        FactSource.Genesis,
        ctx.get(NodeService).getSelfNode(),
      );
    } catch (err) {
      console.error(err);
      console.error(`You probably need to update the genesis block data!`);
    }
  }

  public getTotalCoins() {
    return (1n << 62n);
  }
}
