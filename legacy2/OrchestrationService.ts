import { digestTree, encodeDataTree } from './DataTreeHelper.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { FetchService } from './FetchService.ts';
import { GENERATION_SUCCESS_FLAG, GenerationDriver } from './GenerationDriver.ts';
import { rootHash } from './hashes.ts';
import { JobDriver } from './JobDriver.ts';
import { Verifier } from './messages.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { mapPut } from './util/map.ts';
import { VERIFICATION_SUCCESS_FLAG, VerificationDriver } from './VerifiationDriver.ts';
import { WorkerManager } from './WorkerManager.ts';
import { DataTree } from './protocol/base.ts';

export class OrchestrationService {
  private results = new Map<HashPrimitive, Promise<DataTree>>();
  private wasmModules = new Map<HashPrimitive, Promise<WebAssembly.Module>>();

  constructor(private ctx: Context) {}

  launchGenerator(verifier: Verifier): Promise<DataTree> {
    const runHash = Hash.digest(Verifier.encode(verifier));
    return mapPut(this.results, runHash.toPrimitive(), async () => {
      const scoreFn = () => 1;

      for (const provider of this.ctx.config.contractProviders) {
        if (Hash.equals(provider.contractHash, verifier.contractHash)) {
          const driver = new GenerationDriver(this.ctx, verifier, scoreFn);
          try {
            await provider.compute(driver);
            driver.finish(GENERATION_SUCCESS_FLAG);
          } catch (err) {
            if (err instanceof Error) {
              driver.finish(err);
            } else {
              throw err;
            }
          }
          return driver.getResult();
        }
      }

      // TODO: Only use a wasm (including the verifier wasm) as a generator if there's a generator fulfillment saying it can generate
      return this.ctx.get(WorkerManager).run({
        createDriver: (runner, instanceId) => {
          const driver = new GenerationDriver(this.ctx, verifier, scoreFn);
          return new JobDriver(runner, instanceId, driver, () => driver.getResult());
        },
      }, {
        wasmModule: await this.loadWasmModule(verifier.contractHash),
        calls: ['generate'],
        score: scoreFn,
      });
    });
  }

  launchVerifier(block: BlockFact, verifier: Verifier, hintPrefix: DataTree[]): Promise<DataTree> {
    // TODO: Key by: block.hash, verifier, hintPrefix.slice(1)
    const runHash = Hash.digestParts(block.hash, ...hintPrefix.map(digestTree));
    return mapPut(this.results, runHash.toPrimitive(), async () => {
      const scoreFn = () => 1;

      for (const provider of this.ctx.config.contractProviders) {
        if (Hash.equals(provider.contractHash, verifier.contractHash)) {
          const driver = new VerificationDriver(this.ctx, block, verifier, hintPrefix, scoreFn);
          try {
            await provider.compute(driver);
            driver.finish(VERIFICATION_SUCCESS_FLAG);
          } catch (err) {
            if (err instanceof Error) {
              driver.finish(err);
            } else {
              throw err;
            }
          }
          return driver.getResult();
        }
      }

      return this.ctx.get(WorkerManager).run({
        createDriver: (runner, instanceId) => {
          const driver = new VerificationDriver(this.ctx, block, verifier, hintPrefix, scoreFn);
          return new JobDriver(runner, instanceId, driver, () => driver.getResult());
        },
      }, {
        wasmModule: await this.loadWasmModule(verifier.contractHash),
        calls: ['verify'],
        score: scoreFn,
      });
    });
  }

  private loadWasmModule(contractHash: Hash) {
    return mapPut(
      this.wasmModules,
      contractHash.toPrimitive(),
      () =>
        new Promise<WebAssembly.Module>((resolve) => {
          this.ctx.get(FetchService).fetch({
            contractHash: rootHash,
            params: encodeDataTree(contractHash),
          }, {
            // abortSignal: workerDriver.done.signal,
            // incentive,
            onBody: (body) => {
              if (body !== undefined && body.value !== null) {
                WebAssembly.compile(body.value.bytes).then(resolve, (err) =>
                  console.error(`Could not compile WASM ${contractHash.toHex()}`));
              }
            },
          });
        }),
    );
  }
}
