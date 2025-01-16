import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { Verifier } from './messages.ts';
import * as hashes from './hashes.ts';
import { bin2hex } from './util/hex.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { Logger } from './Logger.ts';

interface Debugger {
  contractName: string;
  paramDebugger?: (params: Uint8Array) => unknown;
  bodyDebugger?: (body: Uint8Array) => unknown;
}

export class QaDebugger {
  private debuggers: Map<HashPrimitive, Debugger> = new Map();

  constructor(private ctx: Context) {
    Object.entries(hashes).forEach(([name, hash]) => this.addDebugger(name, hash));
  }

  public addDebugger(
    contractName: string,
    contractHash: Hash,
    paramDebugger?: (params: Uint8Array) => unknown,
    bodyDebugger?: (body: Uint8Array) => unknown,
  ) {
    this.debuggers.set(contractHash.toPrimitive(), {
      contractName,
      paramDebugger,
      bodyDebugger,
    });
  }

  public debugVerifier(verifier: Verifier) {
    const dbgr = this.debuggers.get(verifier.contractHash.toPrimitive());
    const contractStr = dbgr?.contractName ??
      verifier.contractHash.toHex().slice(0, 10);
    const paramsStr = this.serialize(dbgr?.paramDebugger?.(verifier.params)) ??
      bin2hex(verifier.params).slice(0, 10);
    return `${contractStr}/${paramsStr}`;
  }

  public debugBody(block: BlockFact, groupIdx: number) {
    const body = block.bodies[groupIdx];

    for (const input of block.inputs) {
      if (input.groupIdx === groupIdx) {
        const inputBlock = this.ctx.get(BlockService)
          .get(input.blockHash, false);
        if (inputBlock !== undefined) {
          const verifier = inputBlock.outputs[input.outputIdx].verifier;
          const dbgr = this.debuggers.get(verifier.contractHash.toPrimitive());
          const str = this.serialize(dbgr?.bodyDebugger?.(body));
          if (str !== undefined) {
            return str;
          }
        }
      }
    }

    return bin2hex(body).slice(0, 10);
  }

  private serialize(val: unknown) {
    return typeof val === 'object' ? this.ctx.get(Logger).serialize(val) : val;
  }
}
