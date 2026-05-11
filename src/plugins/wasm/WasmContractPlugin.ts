// Protocol spec: docs/protocol/wasm-abi.md
//
// `ContractPlugin` for on-chain WASM contracts. Accepts any block carrying
// a `wasm` record output; the bytes of that record are the primary WASM
// binary. The block must also carry a `wasm_layers` JSON record describing
// the module stack (mandatory; use `[{}]` for single-module contracts -- see
// docs/protocol/wasm-abi.md#stacking).
//
// `getContract(block)` returns a `Contract` that lazily fetches lower layer
// blobs, compiles all modules, and delegates run / walk_params / walk_data /
// build_params / build_data to a shared `WasmExecutor`.

import { Hash, HASH_SIZE } from '../../util/Hash.ts';
import type { Block } from '../../core/Block.ts';
import { findRecordOutput } from '../../contracts/RecordContract.ts';
import type { Contract } from '../../contracts/Contract.ts';
import type { ContractPlugin } from '../../core/ContractPlugin.ts';
import type { ContractEnv } from '../../core/ContractEnv.ts';
import { WasmExecutor, type WasmExecutorConfig } from './WasmExecutor.ts';
import {
  type CompiledStack,
  type NormalisedStack,
  parseWasmLayers,
  type StackEntry,
} from './WasmLayers.ts';

export interface WasmContractPluginConfig extends WasmExecutorConfig {
  /**
   * Pre-built executor. When supplied, this plugin uses it instead of
   * constructing one. Useful when multiple plugins should share a pool.
   */
  executor?: WasmExecutor;
  /**
   * Resolve a content-addressed blob hash to its bytes. Required when any
   * contract block declares non-empty `wasm_layers` lower entries; otherwise
   * compileStack throws a clear error.
   *
   * In production this wraps `FetchManager.fetch({ contract: HASH_CONTRACT,
   * params: hash.toBytes() }).body` -- see `NodeContext`.
   */
  resolveBlob?: (hash: Hash) => Promise<Uint8Array>;
}

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

function copyToOwnedArrayBuffer(src: Uint8Array): Uint8Array<ArrayBuffer> {
  // WebAssembly.compile requires an ArrayBuffer-backed BufferSource (not SAB).
  // Allocate a fresh ArrayBuffer and copy in.
  const buf = new ArrayBuffer(src.byteLength);
  const owned = new Uint8Array(buf);
  owned.set(src);
  return owned;
}

/**
 * `Contract` implementation backed by a (possibly stacked) WASM binary on a
 * contract block. Lower layer blobs are fetched (via `resolveBlob`) and
 * compiled on first use; the resulting `CompiledStack` is cached on the
 * adapter for subsequent calls.
 */
class WasmContractAdapter implements Contract {
  readonly outputNamespaces: Hash[];
  private readonly _block: Block;
  private readonly _primaryBytes: Uint8Array;
  private readonly _normalisedStack: NormalisedStack;
  private readonly _resolveBlob: WasmContractPluginConfig['resolveBlob'];
  private _stackPromise: Promise<CompiledStack> | null = null;

  constructor(
    private readonly _executor: WasmExecutor,
    block: Block,
    metadata: WasmContractMetadata,
    primaryBytes: Uint8Array,
    normalisedStack: NormalisedStack,
    resolveBlob: WasmContractPluginConfig['resolveBlob'],
  ) {
    this.outputNamespaces = metadata.outputNamespaces;
    this._block = block;
    this._primaryBytes = primaryBytes;
    this._normalisedStack = normalisedStack;
    this._resolveBlob = resolveBlob;
  }

  private compileStack(): Promise<CompiledStack> {
    if (this._stackPromise !== null) return this._stackPromise;
    this._stackPromise = (async (): Promise<CompiledStack> => {
      const layers: StackEntry[] = [];
      for (const lower of this._normalisedStack.layers) {
        if (!this._resolveBlob) {
          throw new Error(
            `WasmContractAdapter: contract block ${this._block.hash.toHex()} ` +
              `declares wasm_layers with a lower-layer blob ${lower.blobHash.toHex()}, but the plugin was constructed without \`resolveBlob\`. ` +
              `Wire one through \`wasmContractPlugin({ resolveBlob })\`.`,
          );
        }
        const blobBytes = await this._resolveBlob(lower.blobHash);
        const owned = copyToOwnedArrayBuffer(blobBytes);
        const module = await WebAssembly.compile(owned);
        layers.push({ module, mapImports: lower.mapImports });
      }
      const primaryModule = await WebAssembly.compile(
        copyToOwnedArrayBuffer(this._primaryBytes),
      );
      return {
        layers,
        primary: { module: primaryModule, mapImports: this._normalisedStack.primary.mapImports },
      };
    })();
    return this._stackPromise;
  }

  async run(env: ContractEnv): Promise<void> {
    const stack = await this.compileStack();
    await this._executor.run(stack, env);
  }

  async walkParams(
    params: Uint8Array,
    host: import('../../contracts/Contract.ts').WalkerHost,
  ): Promise<void> {
    const stack = await this.compileStack();
    await this._executor.walkParams(stack, params, host);
  }

  async walkData(
    data: Uint8Array,
    host: import('../../contracts/Contract.ts').WalkerHost,
  ): Promise<void> {
    const stack = await this.compileStack();
    await this._executor.walkData(stack, data, host);
  }

  async buildParams(host: import('../../contracts/Contract.ts').BuilderHost): Promise<Uint8Array> {
    const stack = await this.compileStack();
    return await this._executor.buildParams(stack, host);
  }

  async buildData(host: import('../../contracts/Contract.ts').BuilderHost): Promise<Uint8Array> {
    const stack = await this.compileStack();
    return await this._executor.buildData(stack, host);
  }
}

/**
 * Build a `ContractPlugin` that handles any contract block carrying a
 * `wasm` record output. The block must also carry a `wasm_layers` JSON
 * record (use `[{}]` for single-module contracts).
 */
export function wasmContractPlugin(
  config: WasmContractPluginConfig = {},
): ContractPlugin<Block> {
  const { executor: providedExecutor, resolveBlob, ...executorConfig } = config;
  const executor = providedExecutor ?? new WasmExecutor(executorConfig);
  return {
    accepts(block: Block): boolean {
      return findRecordOutput(block, 'wasm') !== undefined;
    },
    getContract(block: Block): Contract {
      const wasmRecord = findRecordOutput(block, 'wasm');
      if (!wasmRecord) {
        throw new Error(
          `WasmContractPlugin: block ${block.hash.toHex()} has no \`wasm\` record`,
        );
      }
      const layersRecord = findRecordOutput(block, 'wasm_layers');
      if (!layersRecord) {
        throw new Error(
          `WasmContractPlugin: block ${block.hash.toHex()} is missing a ` +
            `\`wasm_layers\` record (required; use [{}] for single-module contracts -- ` +
            `see docs/protocol/wasm-abi.md#stacking)`,
        );
      }
      const normalisedStack = parseWasmLayers(layersRecord.body);
      const metadata: WasmContractMetadata = {
        outputNamespaces: readOutputNamespaces(block),
      };
      return new WasmContractAdapter(
        executor,
        block,
        metadata,
        wasmRecord.body,
        normalisedStack,
        resolveBlob,
      );
    },
  };
}

export { WasmContractAdapter };
