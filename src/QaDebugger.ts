import { Context } from './Context.ts';
import { Hash } from './util/Hash.ts';
import { Verifier } from './messages.ts';
import * as hashes from './constants.ts';

export class QaDebugger {
  private debuggers: Map<string, {
    contractName: string;
    paramDebugger?: (params: Uint8Array) => any;
    answerDebugger?: (answer: Uint8Array) => any;
  }> = new Map();

  constructor(private ctx: Context) {
    const timeout = ctx.config.timeProvider.setTimeout(() => {
      Object.entries(hashes).forEach(([name, hash]) =>
        this.addDebugger(name, hash)
      );
    }, 0);

    ctx.onDestruct(() => ctx.config.timeProvider.clearTimeout(timeout));
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
    const dbgr = this.debuggers.get(spec.contractHash.toHex());
    if (dbgr) {
      return {
        dbgContract: dbgr.contractName,
        dbgParams: dbgr.paramDebugger
          ? dbgr.paramDebugger(spec.params)
          : undefined,
      };
    }
  }

  public debugAnswer({ bodies }: {
    // verifiers: (Verifier | undefined)[];
    bodies: Uint8Array[];
  }): { dbgAnswer: any } | undefined {
    // const dbgrs = verifiers.map((v) =>
    //   this.debuggers.get(v.contractHash.toHex())
    // ).filter(Boolean);
    // if (dbgrs.length) {
    //   return {
    //     dbgAnswer: dbgrs[0]!.answerDebugger
    //       ? dbgrs[0]!.answerDebugger(body)
    //       : undefined,
    //   };
    // }
    return undefined;
  }
}
