import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { Verifier } from './messages.ts';
import * as hashes from './hashes.ts';
import { bin2hex } from './util/hex.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';

interface Debugger {
  contractName: string;
  paramDebugger?: (params: Uint8Array) => unknown;
  bodyDebugger?: (body: Uint8Array) => unknown;
}

const trim = (str: string, maxLen: number) =>
  str.length > maxLen ? `${str.substring(0, maxLen)}... [${str.length}]` : str;

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
    const paramsStr = this.serialize(dbgr?.paramDebugger?.(verifier.params.value!.bytes)) ??
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
          const str = this.serialize(dbgr?.bodyDebugger?.(body.value!.bytes));
          if (str !== undefined) {
            return str;
          }
        }
      }
    }

    return bin2hex(body).slice(0, 10);
  }

  private serialize(obj: any, n?: number, maxStrLen = 64): string {
    // val = sortKeys(val);
    return JSON.stringify(obj, (key, val) => {
      if (key === 'defaultConn') {
        return;
      }

      if (typeof val === 'bigint') {
        return trim(val.toString(), maxStrLen);
      } else if (typeof val === 'string') {
        return trim(val, maxStrLen);
      } else if (val instanceof Hash) {
        return trim(val.toHex(), maxStrLen);
      } else if (val instanceof Uint8Array) {
        return trim(bin2hex(val), maxStrLen);
      } else if (
        typeof val === 'object' && val !== null && val.type === 'Buffer'
      ) {
        return trim(bin2hex(new Uint8Array(val.data)), maxStrLen);
        // } else if (
        //   typeof val === 'object' && val !== null &&
        //   'contractHash' in val &&
        //   'params' in val
        // ) {
        //   return { ...val, ...this.ctx.get(QaDebugger).debugQuestion(val) };
        // } else if (
        //   typeof val === 'object' && val !== null &&
        //   'verifiers' in val &&
        //   'body' in val
        // ) {
        //   if (val !== obj && 'hash' in val && val.hash instanceof Hash) {
        //     return { hash: trim(val.hash.toHex(), maxStrLen) };
        //   } else {
        //     return { ...val, ...this.ctx.get(QaDebugger).debugAnswer(val) };
        //   }
      } else if (
        key && typeof val === 'object' && val !== null &&
        'hash' in val && val.hash instanceof Hash
      ) {
        return { hash: val.hash };
      } else {
        return val;
      }
    }, n);
  }
}
