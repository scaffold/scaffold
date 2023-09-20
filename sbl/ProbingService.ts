import Context from '~/sbl/Context.ts';
import { BlockSetFact, FactType } from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import LitigationService from '~/sbl/LitigationService.ts';
import { LEAF_BLOCKSET_LEVEL } from '~/sbl/BlockSetService.ts';

export default class ProbingService {
  constructor(private ctx: Context) {}

  public probe(blockSet: BlockSetFact) {
    const leftChild = this.ctx.get(FactService)
      .get(blockSet.left_child, false);
    const rightChild = this.ctx.get(FactService)
      .get(blockSet.right_child, false);

    if (blockSet.level === LEAF_BLOCKSET_LEVEL) {
      if (leftChild !== undefined) {
        if (rightChild !== undefined) {
          // Got both children; we're good
        } else {
          this.ctx.get(LitigationService).litigate(blockSet, {
            ClaimRequestChildHash: { child_idx: 1 },
          });
        }
      } else {
        if (rightChild !== undefined) {
          this.ctx.get(LitigationService).litigate(blockSet, {
            ClaimRequestChildHash: { child_idx: 0 },
          });
        } else {
          this.ctx.get(LitigationService).litigate(blockSet, {
            ClaimRequestWorkProbe: {
              position: this.ctx.config.entropyProvider.randomBytes(8),
            },
          });
        }
      }
      return;
    }

    if (leftChild !== undefined && leftChild.type !== FactType.BlockSet) {
      throw new Error(`Invalid fact type!`);
    }
    if (rightChild !== undefined && rightChild.type !== FactType.BlockSet) {
      throw new Error(`Invalid fact type!`);
    }

    let leftUnknownWork: bigint;
    let rightUnknownWork: bigint;
    if (leftChild !== undefined) {
      leftUnknownWork = leftChild.claimed_work - leftChild.knownWork;

      if (rightChild !== undefined) {
        if (
          leftChild.claimed_work + rightChild.claimed_work !==
            blockSet.claimed_work
        ) {
          throw new Error(`Claimed work does not sum correctly!`);
        }

        rightUnknownWork = rightChild.claimed_work - rightChild.knownWork;
      } else {
        rightUnknownWork = blockSet.claimed_work - leftChild.claimed_work;
      }
    } else {
      if (rightChild !== undefined) {
        leftUnknownWork = blockSet.claimed_work - rightChild.claimed_work;
        rightUnknownWork = rightChild.claimed_work - rightChild.knownWork;
      } else {
        leftUnknownWork = 1n;
        rightUnknownWork = 1n;
      }
    }

    if (leftUnknownWork !== 0n || rightUnknownWork !== 0n) {
      const position = this.ctx.config.entropyProvider.randomBytes(16);
      const child =
        this.lt(position, leftUnknownWork, leftUnknownWork + rightUnknownWork)
          ? leftChild
          : rightChild;

      if (child !== undefined) {
        this.probe(child);
      } else {
        this.ctx.get(LitigationService).litigate(blockSet, {
          ClaimRequestWorkProbe: { position },
        });
      }
    }
  }

  private lt(arr: Uint8Array, num: bigint, den: bigint): boolean {
    for (const byte of arr) {
      const threshold = (num << 8n) / den;
      if (byte < Number(threshold)) {
        return true;
      } else if (byte > Number(threshold)) {
        return false;
      } else {
        num = (num << 8n) - threshold * den;
      }
    }
    return false;
  }
}
