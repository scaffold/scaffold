import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { QuestionSpec } from './messages.ts';
import Logger from './Logger.ts';

export default class QaDebugger {
  private debuggers: Map<string, {
    contractName: string;
    paramDebugger: (params: Uint8Array) => any;
    answerDebugger: (answer: Uint8Array) => any;
  }> = new Map();

  constructor(private ctx: Context) {}

  public addDebugger(
    contractName: string,
    contractHash: Hash,
    paramDebugger: (params: Uint8Array) => any,
    answerDebugger: (answer: Uint8Array) => any,
  ) {
    this.debuggers.set(contractHash.toHex(), {
      contractName,
      paramDebugger,
      answerDebugger,
    });
  }

  public debugQuestion(spec: QuestionSpec) {
    const dbgr = this.debuggers.get(spec.contract_answer_hash.toHex());
    if (dbgr) {
      const paramStr = this.ctx.get(Logger).serialize(
        dbgr.paramDebugger(spec.params),
      );
      return `${dbgr.contractName}${paramStr}`;
    } else {
      return `[unknown]`;
    }
  }
}
