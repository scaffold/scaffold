import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';
import QaDebugger from './QaDebugger.ts';

const sortKeys = (obj: { [key: string]: any }) =>
  Object.fromEntries(
    Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])),
  );

const trim = (str: string, maxLen: number) =>
  str.length > maxLen ? `${str.substring(0, maxLen)}... [${str.length}]` : str;

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

  public serialize(val: any, n = 2, maxStrLen = 64): string {
    // val = sortKeys(val);
    return JSON.stringify(val, (_key, val) => {
      if (typeof val === 'bigint') {
        return trim(val.toString(), maxStrLen);
      } else if (typeof val === 'string') {
        return trim(val, maxStrLen);
      } else if (val instanceof Hash) {
        return trim(`Sha256:${val.toHex()}`, maxStrLen);
      } else if (val instanceof Uint8Array) {
        return trim(bin2hex(val), maxStrLen);
      } else if (
        typeof val === 'object' && val !== null && val.type === 'Buffer'
      ) {
        return trim(bin2hex(new Uint8Array(val.data)), maxStrLen);
      } else if (
        typeof val === 'object' &&
        'contract_hash' in val &&
        'params' in val
      ) {
        return { ...val, ...this.ctx.get(QaDebugger).debugQuestion(val) };
      } else if (
        typeof val === 'object' &&
        'verifier' in val &&
        'body' in val
      ) {
        return { ...val, ...this.ctx.get(QaDebugger).debugAnswer(val) };
      } else {
        return val;
      }
    }, n);
  }
}
