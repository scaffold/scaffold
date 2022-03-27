import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { arrConcat, arrEquals } from '~/sbl/util/buffer.ts';

export default class SampleContracts {
  constructor(private ctx: Context) {}

  public apply(opts: { collatz?: boolean }) {
    opts = Object.assign({ collatz: true }, opts);

    this.applyIdentity();
    this.applySort();

    opts.collatz && this.applyJson(
      'collatz',
      ({ num }, request) => ({
        iters: num === 1
          ? 0
          : request('collatz', { num: num % 2 ? num * 3 + 1 : num / 2 }).iters +
            1,
      }),
    );
  }

  private applyIdentity() {
    const hash = this.getContractHash('identity');

    this.ctx.config.contracts.push({
      hash,
      func: (
        params: Uint8Array,
        answer: Uint8Array,
        _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) => arrEquals(params, answer),
    });

    this.ctx.config.generators.push({
      contractHash: hash,
      isCorrect: true,
      func: (
        params: Uint8Array,
        _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) => params,
    });

    this.ctx.config.generators.push({
      contractHash: hash,
      isCorrect: false,
      func: (
        params: Uint8Array,
        _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) => arrConcat(params, new TextEncoder().encode('extra')),
    });
  }

  private applySort() {
    const hash = this.getContractHash('sort');

    // This contract will still succeed even if the json isn't bytewise-perfect.
    // Most of the other contracts check for bytewise exactness.
    this.ctx.config.contracts.push({
      hash,
      func: (
        params: Uint8Array,
        answer: Uint8Array,
        _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) =>
        JSON.stringify(JSON.parse(new TextDecoder().decode(params)).sort()) ===
          JSON.stringify(JSON.parse(new TextDecoder().decode(answer))),
    });

    this.ctx.config.generators.push({
      contractHash: hash,
      isCorrect: true,
      func: (
        params: Uint8Array,
        _request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) =>
        new TextEncoder().encode(
          JSON.stringify(JSON.parse(new TextDecoder().decode(params)).sort()),
        ),
    });
  }

  private applyJson(
    name: string,
    goodFunc: (
      obj: any,
      request: (contractName: string, params: any) => any,
    ) => any,
    badFunc?: (
      obj: any,
      request: (contractName: string, params: any) => any,
    ) => any,
  ) {
    const hash = this.getContractHash(name);

    const makeRequest = (
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      (contractName: string, params: any) =>
        JSON.parse(
          new TextDecoder().decode(
            request(
              Hash.digest(contractName),
              new TextEncoder().encode(
                JSON.stringify(params),
              ),
            ),
          ),
        );

    this.ctx.config.contracts.push({
      hash,
      func: (
        params: Uint8Array,
        answer: Uint8Array,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) =>
        JSON.stringify(
          goodFunc(
            JSON.parse(new TextDecoder().decode(params)),
            makeRequest(request),
          ),
        ) === JSON.stringify(JSON.parse(new TextDecoder().decode(answer))),
    });

    this.ctx.config.generators.push({
      contractHash: hash,
      isCorrect: true,
      func: (
        params: Uint8Array,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      ) =>
        new TextEncoder().encode(
          JSON.stringify(
            goodFunc(
              JSON.parse(new TextDecoder().decode(params)),
              makeRequest(request),
            ),
          ),
        ),
    });

    if (badFunc) {
      this.ctx.config.generators.push({
        contractHash: hash,
        isCorrect: false,
        func: (
          params: Uint8Array,
          request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
        ) =>
          new TextEncoder().encode(
            JSON.stringify(
              badFunc(
                JSON.parse(new TextDecoder().decode(params)),
                makeRequest(request),
              ),
            ),
          ),
      });
    }
  }

  private getContractHash(name: string) {
    const hash = Hash.digest(name);
    console.log(
      `Special contract with hash ${hash.toHex()} is ${name}`,
    );
    return hash;
  }
}
