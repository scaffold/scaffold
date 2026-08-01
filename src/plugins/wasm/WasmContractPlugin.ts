// Protocol spec: docs/protocol/wasm-abi.md
//
// `ContractPlugin` for on-chain WASM contracts. Accepts any block carrying
// a `modules` JSON record describing the contract's module graph (see
// docs/protocol/wasm-abi.md#stacking). Every layer references a content-
// addressed WASM blob; bytes are fetched via `resolveBlob` (FetchManager +
// HASH_CONTRACT in production).

import { Hash, HASH_SIZE } from '../../util/Hash.ts';
import type { Block } from '../../core/Block.ts';
import { findRecordOutput } from '../../contracts/RecordContract.ts';
import type { Contract } from '../../contracts/Contract.ts';
import type { ContractPlugin } from '../../core/ContractPlugin.ts';
import type { ContractEnv } from '../../core/ContractEnv.ts';
import { WasmExecutor, type WasmExecutorConfig } from './WasmExecutor.ts';
import {
  type CompiledLayer,
  type CompiledModules,
  type NormalisedModules,
  parseModules,
} from './WasmModules.ts';
import { Reader } from '../../contract/Reader.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';

export interface WasmContractPluginConfig extends WasmExecutorConfig {
  /** Pre-built executor (lets multiple plugins share one). */
  executor?: WasmExecutor;
  /**
   * Resolve a content-addressed blob hash to its bytes. Required for every
   * `modules` block. In production this wraps
   * `FetchManager.fetch({ contract: HASH_CONTRACT, params: hash.toBytes() }).body`.
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

function copyToOwnedArrayBuffer(src: Uint8Array) {
  const buf = new ArrayBuffer(src.byteLength);
  const owned = new Uint8Array(buf);
  owned.set(src);
  return owned;
}

class WasmContractAdapter implements Contract {
  readonly outputNamespaces: Hash[];
  private readonly _block: Block;
  private readonly _normalised: NormalisedModules;
  private readonly _resolveBlob: WasmContractPluginConfig['resolveBlob'];
  private _compiledPromise: Promise<CompiledModules> | null = null;

  constructor(
    private readonly _executor: WasmExecutor,
    block: Block,
    metadata: WasmContractMetadata,
    normalised: NormalisedModules,
    resolveBlob: WasmContractPluginConfig['resolveBlob'],
  ) {
    this.outputNamespaces = metadata.outputNamespaces;
    this._block = block;
    this._normalised = normalised;
    this._resolveBlob = resolveBlob;
  }

  private compile(): Promise<CompiledModules> {
    if (this._compiledPromise !== null) return this._compiledPromise;
    this._compiledPromise = (async (): Promise<CompiledModules> => {
      if (!this._resolveBlob) {
        throw new Error(
          `WasmContractAdapter: contract block ${this._block.hash.toHex()} ` +
            `cannot resolve modules.layers because the plugin was constructed ` +
            `without \`resolveBlob\`. Wire one through ` +
            `\`wasmContractPlugin({ resolveBlob })\`.`,
        );
      }
      const layers: CompiledLayer[] = [];
      const byKey = new Map<string, CompiledLayer>();
      for (const layer of this._normalised.layers) {
        const blobBytes = await this._resolveBlob(layer.blobHash);
        const owned = copyToOwnedArrayBuffer(blobBytes);
        const module = await WebAssembly.compile(owned);
        const entry: CompiledLayer = { key: layer.key, module, imports: layer.imports };
        layers.push(entry);
        byKey.set(layer.key, entry);
      }
      return { base: this._normalised.base, layers, byKey };
    })();
    return this._compiledPromise;
  }

  async run(env: ContractEnv): Promise<void> {
    const compiled = await this.compile();
    await this._executor.run(compiled, env);
  }

  async walkParams(
    params: Uint8Array,
    host: import('../../contracts/Contract.ts').WalkerHost,
  ): Promise<void> {
    const compiled = await this.compile();
    await this._executor.walkParams(compiled, params, host);
  }

  async walkData(
    data: Uint8Array,
    host: import('../../contracts/Contract.ts').WalkerHost,
  ): Promise<void> {
    const compiled = await this.compile();
    await this._executor.walkData(compiled, data, host);
  }

  async buildParams(host: (descriptor: string) => MaybePromise<Reader>): Promise<Uint8Array> {
    const compiled = await this.compile();
    return await this._executor.buildParams(compiled, host);
  }

  async buildData(host: (descriptor: string) => MaybePromise<Reader>): Promise<Uint8Array> {
    const compiled = await this.compile();
    return await this._executor.buildData(compiled, host);
  }
}

/**
 * Build a `ContractPlugin` that handles contract blocks carrying a `modules`
 * record. `resolveBlob` is required to actually run any contract.
 */
export function wasmContractPlugin(
  config: WasmContractPluginConfig = {},
): ContractPlugin<Block> {
  const { executor: providedExecutor, resolveBlob, ...executorConfig } = config;
  const executor = providedExecutor ?? new WasmExecutor(executorConfig);
  return {
    accepts(block: Block): boolean {
      return findRecordOutput(block, 'modules') !== undefined;
    },
    getContract(block: Block): Contract {
      const modulesRecord = findRecordOutput(block, 'modules');
      if (!modulesRecord) {
        throw new Error(
          `WasmContractPlugin: block ${block.hash.toHex()} has no \`modules\` record`,
        );
      }
      const normalised = parseModules(modulesRecord.body);
      const metadata: WasmContractMetadata = {
        outputNamespaces: readOutputNamespaces(block),
      };
      return new WasmContractAdapter(executor, block, metadata, normalised, resolveBlob);
    },
  };
}

export { WasmContractAdapter };
