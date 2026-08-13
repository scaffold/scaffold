import { Context } from '../../Context.ts';
import { error } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { Contract } from '../env/Contract.ts';
import { ContractEnv } from '../env/ContractEnv.ts';
import { SinkRoot, SourceRoot } from '../values.ts';
import { buildImports, runImports, walkImports } from './WasmAbi.ts';
import { WasmConfig } from './WasmConfig.ts';
import { parseManifest, WasmEntryPoint, WasmManifest } from './WasmManifest.ts';
import { WasmRuntime } from './WasmRuntime.ts';

interface Loaded {
  manifest: WasmManifest;
  module: WebAssembly.Module;
}

// A Contract bound to one contract hash: the hash of its manifest blob. The
// manifest and module are fetched lazily on first use and the compiled
// WebAssembly.Module is the cached artifact; instances are never reused.
export class WasmContract implements Contract {
  private loading?: Promise<Loaded>;
  private loadAbort = new AbortController();

  constructor(private ctx: Context, private contract: Hash) {}

  [Symbol.dispose]() {
    this.loadAbort.abort();
  }

  async run(env: ContractEnv, flowCtl: FlowCtl): Promise<void> {
    const { manifest, module } = await this.load();
    await this.transport().invoke(module, manifest.entries.run, {
      scaffold_env: runImports(env, this.onDebug),
    }, { signal: flowCtl.signal });
  }

  buildParams(source: SourceRoot): Promise<Uint8Array> {
    return this.build('build_params', source);
  }

  buildBody(source: SourceRoot): Promise<Uint8Array> {
    return this.build('build_body', source);
  }

  walkParams(params: Uint8Array, sink: SinkRoot): Promise<void> {
    return this.walk('walk_params', params, sink);
  }

  walkBody(body: Uint8Array, sink: SinkRoot): Promise<void> {
    return this.walk('walk_body', body, sink);
  }

  private async walk(entry: WasmEntryPoint, bytes: Uint8Array, sink: SinkRoot): Promise<void> {
    const { manifest, module } = await this.load();
    const walker = walkImports(sink);
    await this.transport().invoke(module, this.entryExport(manifest, entry), {
      scaffold_walker: walker.imports,
    }, { arg: bytes });
    walker.finish();
  }

  private async build(entry: WasmEntryPoint, source: SourceRoot): Promise<Uint8Array> {
    const { manifest, module } = await this.load();
    const result = await this.transport().invoke(module, this.entryExport(manifest, entry), {
      scaffold_builder: buildImports(source),
    });
    return result ?? error(`${entry} returned no result`);
  }

  private entryExport(manifest: WasmManifest, entry: WasmEntryPoint): string {
    return manifest.entries[entry] ??
      error(`contract ${this.contract.toHex()} does not define ${entry}`);
  }

  private transport() {
    return this.ctx.get(WasmRuntime).transport();
  }

  // Only successful loads are cached: fetch aborts are transient and
  // content-addressed refetches are idempotent.
  private load(): Promise<Loaded> {
    return this.loading ??= this.doLoad().catch((e) => {
      this.loading = undefined;
      this.ctx.logger('wasm')?.warn('loadFailed', {
        contract: this.contract.toHex(),
        error: String(e),
      });
      throw e;
    });
  }

  private async doLoad(): Promise<Loaded> {
    const fetchBlob = this.ctx.get(WasmConfig).fetchBlob ??
      error('WasmConfig.fetchBlob is not configured');
    const manifest = parseManifest(
      await fetchBlob(this.ctx, this.contract, this.loadAbort.signal),
    );
    // Copy to an owned ArrayBuffer: compile rejects SAB-backed views.
    const module = await WebAssembly.compile(
      new Uint8Array(await fetchBlob(this.ctx, manifest.module, this.loadAbort.signal)),
    );
    const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
    for (const name of ['memory', 'alloc', ...Object.values(manifest.entries)]) {
      if (!exportNames.has(name)) {
        throw new Error(`contract ${this.contract.toHex()} module does not export "${name}"`);
      }
    }
    this.ctx.logger('wasm')?.debug('loaded', {
      contract: this.contract.toHex(),
      entries: Object.keys(manifest.entries),
    });
    return { manifest, module };
  }

  private onDebug = (message: string) => {
    this.ctx.logger('wasm')?.debug('guestDebug', { contract: this.contract.toHex(), message });
  };
}
