import Hash from './util/Hash.ts';
import { arrEquals, bin2str, str2bin } from './util/buffer.ts';
import { hex2bin } from './util/hex.ts';

type ResourceEntry = string | Uint8Array | Hash;

export type Resource = (ResourceEntry[] | ResourceEntry)[] | string | URL;

export default class Query {
  public static fromResource(resource: Resource) {
    if (typeof resource === 'string') {
      resource = new URL(resource);
    }

    if (resource instanceof URL) {
      if (resource.protocol !== 'scf:') {
        throw new Error(`Invalid protocol ${resource.protocol}`);
      }
      resource = resource.pathname.split('/');
    }

    const arr = resource.flatMap((cmd) => {
      let calls: ResourceEntry[];
      if (typeof cmd === 'string') {
        calls = cmd.split('.');
      } else {
        calls = Array.isArray(cmd) ? cmd : [cmd];
      }

      if (!calls.some(Boolean)) {
        return [];
      }

      const res = calls.map((x) => {
        if (typeof x === 'string') {
          return str2bin(x);
        } else if (x instanceof Uint8Array) {
          return x;
        } else if (x instanceof Hash) {
          return x.toBytes();
        } else {
          throw new Error(`Invalid resource!`);
        }
      });

      return [res];
    });

    return new Query(arr);
  }

  private static evaluate(arr: Uint8Array[]) {
    if (arr.length === 0) {
      throw new Error(`Invalid command!`);
    }

    arr = [...arr];

    let val = arr.pop()!;
    while (true) {
      const func = arr.pop();
      if (func === undefined) {
        return [val];
      } else if (arrEquals(func, str2bin('hex'))) {
        val = hex2bin(bin2str(val));
      } else {
        arr.push(func);
        break;
      }
    }
    arr.push(val);
    return arr;
  }

  constructor(public arr: Uint8Array[][]) {
    this.arr = this.arr.map((cmd) => Query.evaluate(cmd));
  }

  public toVerifier() {
    const [
      [loadCmd, contractHash, loadRest],
      [paramsCmd, params, paramsRest],
      arrRest,
    ] = this.arr;
    if (
      arrEquals(loadCmd, str2bin('load')) && contractHash !== undefined &&
      loadRest === undefined && arrEquals(paramsCmd, str2bin('params')) &&
      params !== undefined && paramsRest === undefined && arrRest === undefined
    ) {
      return { contract_hash: Hash.fromBytes(contractHash), params };
    } else {
      throw new Error(`Not a valid verifier query!`);
    }
  }
}
