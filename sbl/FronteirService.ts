import { BlockSetFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { NUM_BLOCKSET_LEVELS } from '~/sbl/BlockSetService.ts';
import Hash from '~/sbl/util/Hash.ts';
import { Connection } from '~/sbl/ConnectionService.ts';

const MIN_VOTE_LEVEL = 4;

export default class FronteirService {
  // This is the canonical (to our best knowledge) fronteir.
  private fronteir: (BlockSetFact | undefined)[] = [];

  constructor(private ctx: Context) {
    for (let i = 0; i < NUM_BLOCKSET_LEVELS; i++) {
      this.fronteir.push(undefined);
    }
  }

  public getBlockVote() {
    const fact = this.fronteir[MIN_VOTE_LEVEL];
    return fact !== undefined ? fact.hash : Hash.fromLiteral32(0);
  }

  public sendTo(conn: Connection) {
    this.fronteir.forEach((fact) => {
      if (fact !== undefined) {
        conn.sendReliable(fact.data);
      }
    });
  }
}
