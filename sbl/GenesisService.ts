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
    nodeNonce: Hash.digest(genesisPrivateKey).toBytes(),

    networkProvider: { protocols: new Map() },

    enableValidation: false,
  });

  const block = ctx.get(BlockBuilder).emit({
    body: genesisPublicKey,
  }, []);
  initAccounts.forEach((publicKey) =>
    block.outputs.push({
      verifier: {
        contract_hash: accountHash,
        params: AccountContractParams.encode({ public_key: publicKey }),
      },
      amount: 1000000n,
    })
  );
  return ctx.get(BlockService).create(block);
};

console.log('Genesis block hex:', bin2hex(createGenesisBlock().data));
const genesisData = hex2bin(
  '02000480897a53424c000000000000000000000000000000000000000000006163636f756e7442404b84b37d0432660e441bb1c61370264780e28abe74598571b2d5e908ea4a578480897a53424c000000000000000000000000000000000000000000006163636f756e74444202c39ba41bb22646dfd4bc10e1575032db4b7c57bdb34e0e52268f950be817c6790000000000000000000000000000000000000000000000000000000000000000004203709e4ca7819f7e53b578454d5da4eb791fb3dc05f3bfa532af407ac14f055ff2000101b4d39cb8c362255d039274275d0ec2121a78d95b77307ba910f6e267ed8ec4426d6e14c6e266418ce3991d92bf3417591c013cccd084d5afd5678063474aafdd71292c03dd57',
);

export default class GenesisService {
  constructor(private ctx: Context) {
    ctx.get(FactService).ingest(
      genesisData,
      FactSource.Genesis,
      ctx.get(NodeService).getSelfNode(),
    );
  }

  public getTotalCoins() {
    return (1n << 62n);
  }
}
