import {
  BlockSetFact,
  FactBase,
  FactSource,
  FactType,
  FrontierFact,
} from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { NUM_BLOCKSET_LEVELS } from '~/sbl/BlockSetService.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import { Connection } from '~/sbl/ConnectionService.ts';
import { FrontierMessage } from '~/sbl/messages.ts';
import secp from '~/sbl/util/secp.ts';
import FactService from '~/sbl/FactService.ts';
import KeyService from '~/sbl/KeyService.ts';
import NodeService from '~/sbl/NodeService.ts';

const MIN_VOTE_LEVEL = 4;

export interface FrontierMeta {}

export default class FrontierService {
  // This is the canonical (to our best knowledge) fronteir.
  private fronteir: (BlockSetFact | undefined)[] = [];

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      this.fronteir.push(undefined);
    }
  }

  public getBlockVote() {
    const fact = this.fronteir[MIN_VOTE_LEVEL];
    return fact !== undefined ? fact.hash : ZERO_HASH;
  }

  public sendTo(conn: Connection) {
    this.fronteir.forEach((fact) => {
      if (fact !== undefined) {
        conn.sendReliable(fact.data);
      }
    });
  }

  public createFact(base: FactBase): FrontierFact {
    const frontier = FrontierMessage.decode(base.message);

    if (
      base.signature === undefined ||
      !secp.verify(base.signature, base.hash.toBytes(), frontier.public_key)
    ) {
      throw new Error(`Invalid frontier signature!`);
    }

    const meta: FrontierMeta = {};

    const fact: FrontierFact = Object.assign(
      base,
      frontier,
      meta,
      { type: FactType.Frontier as const },
    );

    return fact;
  }

  private updateFrontier(idx: number, blockSet: BlockSetFact) {
    this.fronteir[idx] = blockSet;

    const frontier: FrontierMessage = {
      public_key: this.ctx.get(KeyService).getSelfPublicKey(),
      idx,
      frontier: blockSet.hash,
    };

    const data = this.ctx.get(FactService)
      .compose(frontier, FrontierMessage, FactType.Frontier);
    const fact = this.ctx.get(FactService).ingest(
      data,
      FactSource.Local,
      this.ctx.get(NodeService).getSelfNode(),
    );
    if (fact.type !== FactType.Frontier) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }
  }
}
