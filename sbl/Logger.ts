import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';

export default class Logger {
  constructor(private ctx: Context) {}

  public log(
    className: string,
    methodName: string,
    params: { [key: string]: any },
  ) {
    console.log(
      `${className}.${methodName}(${
        JSON.stringify(params, (key, val) => this.serialize(val), 0)
      })`,
    );
  }

  private serialize(val: any) {
    if (typeof val === 'bigint') return val.toString();
    else if (val instanceof Hash) return `Sha256:${val.toHex()}`;
    else if (val instanceof Uint8Array) return bin2hex(val);
    else return val;
  }
}
