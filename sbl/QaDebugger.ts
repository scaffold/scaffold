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
    { verifiers, body }: { verifiers: Verifier[]; body: Uint8Array },
  ) {
    const dbgrs = verifiers.map((v) =>
      this.debuggers.get(v.contract_hash.toHex())
    ).filter(Boolean);
    if (dbgrs.length) {
      return {
        dbgAnswer: dbgrs[0]!.answerDebugger
          ? dbgrs[0]!.answerDebugger(body)
          : undefined,
      };
    }
  }
}
