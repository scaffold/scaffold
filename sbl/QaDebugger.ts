import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Verifier } from './messages.ts';
import {
  accountHash,
  loadHash,
  rootHash,
  selfHash,
  timeHash,
} from './constants.ts';

export default class QaDebugger {
  private debuggers: Map<string, {
    contractName: string;
    paramDebugger?: (params: Uint8Array) => any;
    answerDebugger?: (answer: Uint8Array) => any;
  }> = new Map();

  constructor(private ctx: Context) {
    this.addDebugger('Root', rootHash);
    this.addDebugger('Account', accountHash);
    this.addDebugger('Load', loadHash);
    this.addDebugger('Time', timeHash);
    this.addDebugger('Self', selfHash);
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
