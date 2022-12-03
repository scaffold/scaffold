import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';
import { Buffer } from 'std-fix-abortable/node/buffer.ts';
import QaDebugger from './QaDebugger.ts';

export default class Logger {
  constructor(private ctx: Context) {}

  public log(
    className: string,
    methodName: string,
    params: Record<string, any>,
  ) {
    if (this.ctx.config.log) {
      this.ctx.config.log.handler(this.ctx, className, methodName, params);
    }
  }

  public serialize(val: any): string {
    return JSON.stringify(val, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      else if (val instanceof Hash) return `Sha256:${val.toHex()}`;
      else if (val instanceof Uint8Array) return bin2hex(val);
      else if (val.type === 'Buffer') return bin2hex(new Uint8Array(val.data));
      else if (
        typeof val === 'object' &&
        'contract_hash' in val &&
        'params' in val
      ) {
        return { ...val, ...this.ctx.get(QaDebugger).debugQuestion(val) };
      } else if (
        typeof val === 'object' && 'question' in val && 'answer' in val
      ) {
        return { ...val, ...this.ctx.get(QaDebugger).debugAnswer(val) };
      } else return val;
    }, 2);
  }
}
