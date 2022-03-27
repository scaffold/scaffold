import Context from './Context.ts';
import { Connection } from './ConnectionService.ts';
import Hash from './util/Hash.ts';
import AnswerService from './AnswerService.ts';
import { arrConcat, fromNumber } from './util/buffer.ts';
import { bin2hex } from './util/hex.ts';
import { Node } from './NodeService.ts';
import * as hashes from './hashes.ts';
import { CollateralMessage } from './messages.ts';
import QuestionService from './QuestionService.ts';
import MessageCtx from './MessageCtx.ts';

export default class CollateralService {
  // Need a map if we don't want multiple packets duplicating collateral (which we don't).
  // Or maybe just duplicate in the answer array.
  // The key should be the commitment hash, which should be what the contract uses.
  private registry: Map<string, {}> = new Map();

  constructor(private ctx: Context) {}

  public handleCollateralMessage(msgCtx: MessageCtx, msg: CollateralMessage) {
    this.ctx.get(QuestionService).addCollateral(msg.publication_hash);
    let entry = this.registry.get(msg.signature);
    if (!entry) {
      entry = {};
      this.registry.set(msg.signature, entry);

      this.ctx.get(AnswerService).addCollateral(msg.answerHash, entry);
    }
  }
}
