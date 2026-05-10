// Protocol spec: docs/protocol/wasm-abi.md
//
// `ContractPlugin` for on-chain WASM contracts. Accepts any block carrying
// a `wasm` record output; the bytes of that record are the WASM binary.
// `getContract(block)` returns a `Contract` that lazily compiles the
// module and delegates run / walk_params / walk_data / build_params /
// build_data to a shared `WasmExecutor`.

import { Hash, HASH_SIZE } from '../../util/Hash.ts';
import type { Block } from '../../core/Block.ts';
import { findRecordOutput } from '../../contracts/RecordContract.ts';
import type { Contract } from '../../contracts/Contract.ts';
import type { ContractPlugin } from '../../core/ContractPlugin.ts';
import type { ContractEnv } from '../../core/ContractEnv.ts';
import { WasmExecutor, type WasmExecutorConfig } from './WasmExecutor.ts';

export interface WasmContractPluginConfig extends WasmExecutorConfig {
  /**
   * Pre-built executor. When supplied, this plugin uses it instead of
   * constructing one. Useful when multiple plugins should share a pool.
   */
  executor?: WasmExecutor;
}

/**
 * Decoded contract-block metadata. Populated lazily on first access.
 */
interface WasmContractMetadata {
  readonly outputNamespaces: Hash[];
}

function readOutputNamespaces(block: Block): Hash[] {
  const record = findRecordOutput(block, 'output_namespaces');
  if (!record) return [];
  const body = record.body;
  if (body.length === 0) return [];
  if (body.length % HASH_SIZE !== 0) {
    throw new Error(
      `output_namespaces record on ${block.hash.toHex()} has length ` +
        `${body.length}, not a multiple of ${HASH_SIZE}`,
    );
  }
  const result: Hash[] = [];
  for (let i = 0; i < body.length; i += HASH_SIZE) {
    result.push(Hash.fromBytes(body.slice(i, i + HASH_SIZE)));
  }
  return result;
}

/**
 * `Contract` implementation backed by a WASM binary on a contract block.
 *
 * The binary is compiled lazily on first `run` / `walk*` / `build*` call
 * and cached on the adapter. Subsequent calls reuse the compiled module.
 */
class WasmContractAdapter implements Contract {
  readonly outputNamespaces: Hash[];
  private readonly _wasmBytes: Uint8Array;
  private _modulePromise: Promise<WebAssembly.Module> | null = null;

  constructor(
    private readonly _executor: WasmExecutor,
    block: Block,
    _metadata: WasmContractMetadata,
    wasmBytes: Uint8Array,
  ) {
    this.outputNamespaces = _metadata.outputNamespaces;
    this._wasmBytes = wasmBytes;
    // Silence unused warning while keeping the field on the constructor
    // signature -- a later revision may stash block-derived metadata
    // (max_memory_pages, budget_ms_hint) here for the adapter to use.
    void block;
  }

  private getModule(): Promise<WebAssembly.Module> {
    if (this._modulePromise === null) {
      // Copy into a fresh ArrayBuffer-backed Uint8Array: `body` on a wire
      // Output may be a view over a SharedArrayBuffer (from a worker), but
      // WebAssembly.compile requires a plain ArrayBuffer-backed BufferSource.
      const bytes = new Uint8Array(this._wasmBytes.byteLength);
      bytes.set(this._wasmBytes);
      this._modulePromise = WebAssembly.compile(bytes);
    }
    return this._modulePromise;
  }

  async run(env: ContractEnv): Promise<void> {
    const module = await this.getModule();
    await this._executor.run(module, env);
  }

  async walkParams(
    params: Uint8Array,
    host: import('../../contracts/Contract.ts').WalkerHost,
  ): Promise<void> {
    const module = await this.getModule();
    await this._executor.walkParams(module, params, host);
  }

  async walkData(
    data: Uint8Array,
    host: import('../../contracts/Contract.ts').WalkerHost,
  ): Promise<void> {
    const module = await this.getModule();
    await this._executor.walkData(module, data, host);
  }

  async buildParams(host: import('../../contracts/Contract.ts').BuilderHost): Promise<Uint8Array> {
    const module = await this.getModule();
    return await this._executor.buildParams(module, host);
  }

  async buildData(host: import('../../contracts/Contract.ts').BuilderHost): Promise<Uint8Array> {
    const module = await this.getModule();
    return await this._executor.buildData(module, host);
  }
}

/**
 * Build a `ContractPlugin` that handles any contract block carrying a
 * `wasm` record output. Pass `executor` to share an executor (and its
 * worker pool) across plugins; otherwise one is constructed from the
 * remaining executor config and owned by this plugin.
 *
 * Note: the returned plugin shares a single `WasmExecutor` across all
 * blocks it handles. The executor is constructed once at plugin-build
 * time and lives for the lifetime of the host.
 */
export function wasmContractPlugin(
  config: WasmContractPluginConfig = {},
): ContractPlugin<Block> {
  const { executor: providedExecutor, ...executorConfig } = config;
  const executor = providedExecutor ?? new WasmExecutor(executorConfig);
  return {
    accepts(block: Block): boolean {
      return findRecordOutput(block, 'wasm') !== undefined;
    },
    getContract(block: Block): Contract {
      const wasmRecord = findRecordOutput(block, 'wasm');
      if (!wasmRecord) {
        // Should be unreachable -- `accepts` was true.
        throw new Error(
          `WasmContractPlugin: block ${block.hash.toHex()} has no \`wasm\` record`,
        );
      }
      const metadata: WasmContractMetadata = {
        outputNamespaces: readOutputNamespaces(block),
      };
      return new WasmContractAdapter(executor, block, metadata, wasmRecord.body);
    },
  };
}

// Internal export for tests that want to introspect the adapter shape.
export { WasmContractAdapter };
