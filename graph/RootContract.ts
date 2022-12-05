import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { rootHash } from '~/sbl/constants.ts';
import QaDebugger from '~/sbl/QaDebugger.ts';
import GraphUtils from '../sbl/GraphUtils.ts';

export default class RootContract {
  constructor(private ctx: Context) {}

  public get() {
    const rootContract = (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      Hash.equals(
        Hash.digest(request(contractHash, params)),
        Hash.fromBytes(params),
      );

    const contractHash = this.ctx.get(GraphUtils).ingestBlock({
      verifier: { contract_hash: rootHash, params: new Uint8Array([]) },
      claims: [],
      incentives: [],
      body: new TextEncoder().encode(rootContract.toString()),
      timestamp: 0n,
    });

    this.ctx.get(QaDebugger).addDebugger(
      'RootContract',
      contractHash,
      (params) => ({ hash: Hash.fromBytes(params) }),
      (answer) => ({ answer }),
    );

    return contractHash;
  }
}
