import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Verifier } from './messages.ts';
import * as hashes from './constants.ts';

export default class QaDebugger {
  private debuggers: Map<string, {
    contractName: string;
    paramDebugger?: (params: Uint8Array) => any;
    answerDebugger?: (answer: Uint8Array) => any;
  }> = new Map();

  constructor(private ctx: Context) {
    setTimeout(() => {
      Object.entries(hashes).forEach(([name, hash]) =>
        this.addDebugger(name, hash)
      );
    }, 0);
  }

  public addDebugger(
    contractName: string,
    contractHash: Hash,
    paramDebugger?: (params: Uint8Array) => any,
    answerDebugger?: (answer: Uint8Array) => any,
  ) {
    this.debuggers.set(contractHash.toHex(), {
      contractName,
      paramDebugger,
      answerDebugger,
    });
  }

  public debugQuestion(spec: Verifier) {
    const dbgr = this.debuggers.get(spec.contract_hash.toHex());
    if (dbgr) {
      return {
        dbgContract: dbgr.contractName,
        dbgParams: dbgr.paramDebugger
          ? dbgr.paramDebugger(spec.params)
          : undefined,
      };
    }
  }

  public debugAnswer(
    { verifier, body }: { verifier: Verifier; body: Uint8Array },
  ) {
    const dbgr = this.debuggers.get(verifier.contract_hash.toHex());
    if (dbgr) {
      return {
        dbgAnswer: dbgr.answerDebugger ? dbgr.answerDebugger(body) : undefined,
      };
    }
  }
}
