import { Hash, HashPrimitive } from '../util/Hash.ts';

/** A JS contract function */
export type ContractFn = (ctx: ContractContext) => Promise<void> | void;

/** Context provided to contract functions during execution */
export interface ContractContext {
  /** The block's declared inputs (blocks it depends on) */
  readonly inputs: ReadonlyArray<{ hash: Hash; output: Uint8Array }>;
  /** The contract parameters */
  readonly params: Uint8Array;
  /** Emit an output from this contract execution */
  emit(data: Uint8Array): void;
  /** Request the canonical result of another verifier (for computation DAG) */
  request(contractHash: Hash, params: Uint8Array): Promise<Uint8Array>;
  /** Declare the weight of the block being generated */
  declareWeight(weight: number): void;
}

/** Result of executing a contract */
export interface ExecutionResult {
  outputs: Uint8Array[];
  declaredWeight: number;
  dependencies: Array<{ contractHash: Hash; params: Uint8Array }>;
}

export class ContractExecutor {
  private contracts: Map<string, ContractFn>;

  constructor(contracts: Map<string, ContractFn>) {
    this.contracts = contracts;
  }

  /** Check if a contract is registered */
  hasContract(contractHash: Hash): boolean {
    return this.contracts.has(contractHash.toPrimitive());
  }

  /** Execute a contract with given inputs and params */
  async execute(
    contractHash: Hash,
    params: Uint8Array,
    inputs: Array<{ hash: Hash; output: Uint8Array }>,
    requestFn?: (contractHash: Hash, params: Uint8Array) => Promise<Uint8Array>,
  ): Promise<ExecutionResult> {
    const key = contractHash.toPrimitive();
    const fn = this.contracts.get(key);
    if (!fn) {
      throw new Error(`Unknown contract: ${contractHash.toHex()}`);
    }

    const outputs: Uint8Array[] = [];
    let declaredWeight = 1;
    const dependencies: Array<{ contractHash: Hash; params: Uint8Array }> = [];

    const ctx: ContractContext = {
      inputs,
      params,
      emit(data: Uint8Array): void {
        outputs.push(data);
      },
      request(reqContractHash: Hash, reqParams: Uint8Array): Promise<Uint8Array> {
        if (!requestFn) {
          throw new Error('request() called but no requestFn was provided');
        }
        dependencies.push({ contractHash: reqContractHash, params: reqParams });
        return requestFn(reqContractHash, reqParams);
      },
      declareWeight(weight: number): void {
        declaredWeight = weight;
      },
    };

    await fn(ctx);

    return { outputs, declaredWeight, dependencies };
  }
}
