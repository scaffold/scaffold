import Context from '~/sbl/Context.ts';
import ExecutionProvider from '~/sbl/ExecutionProvider.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { bin2hex } from '~/sbl/pathUtils.ts';

export default class ExecutionService {
  private providers: ExecutionProvider[];

  constructor(private ctx: Context) {
    this.providers = ctx.config.executionProviders.toSorted((a, b) =>
      b.magicBytes.byteLength - a.magicBytes.byteLength
    );

    for (const a of this.providers) {
      for (const b of this.providers) {
        if (arrEquals(a.magicBytes, b.magicBytes)) {
          throw new Error(
            `Cannot register two execution providers with the same magic bytes ${
              bin2hex(a.magicBytes)
            }!`,
          );
        }
      }
    }
  }

  public getProvider(code: Uint8Array) {
    return this.providers.find((provider) =>
      arrEquals(
        provider.magicBytes,
        code.subarray(0, provider.magicBytes.byteLength),
      )
    );
  }
}
