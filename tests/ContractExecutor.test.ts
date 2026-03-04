import { assert, assertEquals, assertRejects } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { ContractExecutor, ContractFn, ExecutionResult } from '../src/node/ContractExecutor.ts';

// -- Helpers ----------------------------------------------------------

function makeContractMap(
  entries: Array<[Hash, ContractFn]>,
): Map<string, ContractFn> {
  const map = new Map<string, ContractFn>();
  for (const [hash, fn] of entries) {
    map.set(hash.toPrimitive(), fn);
  }
  return map;
}

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

// -- Tests ------------------------------------------------------------

Deno.test('execute a simple contract that emits outputs', async () => {
  const contractHash = Hash.digest('simple-contract');
  const contract: ContractFn = (ctx) => {
    ctx.emit(encode('hello'));
    ctx.emit(encode('world'));
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));
  const result = await executor.execute(contractHash, new Uint8Array(), []);

  assertEquals(result.outputs.length, 2);
  assertEquals(decode(result.outputs[0]), 'hello');
  assertEquals(decode(result.outputs[1]), 'world');
});

Deno.test('default weight is 1 when declareWeight is not called', async () => {
  const contractHash = Hash.digest('default-weight');
  const contract: ContractFn = (ctx) => {
    ctx.emit(encode('data'));
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));
  const result = await executor.execute(contractHash, new Uint8Array(), []);

  assertEquals(result.declaredWeight, 1);
});

Deno.test('contract can declare a custom weight', async () => {
  const contractHash = Hash.digest('weight-contract');
  const contract: ContractFn = (ctx) => {
    ctx.declareWeight(42);
    ctx.emit(encode('weighted'));
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));
  const result = await executor.execute(contractHash, new Uint8Array(), []);

  assertEquals(result.declaredWeight, 42);
  assertEquals(result.outputs.length, 1);
});

Deno.test('contract can use request() with a mock requestFn', async () => {
  const contractHash = Hash.digest('requesting-contract');
  const otherHash = Hash.digest('other-contract');
  const otherParams = encode('other-params');

  const contract: ContractFn = async (ctx) => {
    const result = await ctx.request(otherHash, otherParams);
    ctx.emit(result);
  };

  const mockRequestFn = async (_hash: Hash, _params: Uint8Array): Promise<Uint8Array> => {
    return encode('response-from-other');
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));
  const result = await executor.execute(contractHash, new Uint8Array(), [], mockRequestFn);

  assertEquals(result.outputs.length, 1);
  assertEquals(decode(result.outputs[0]), 'response-from-other');
});

Deno.test('dependencies are tracked from request() calls', async () => {
  const contractHash = Hash.digest('dep-tracking');
  const dep1Hash = Hash.digest('dep1');
  const dep2Hash = Hash.digest('dep2');
  const dep1Params = encode('p1');
  const dep2Params = encode('p2');

  const contract: ContractFn = async (ctx) => {
    await ctx.request(dep1Hash, dep1Params);
    await ctx.request(dep2Hash, dep2Params);
  };

  const mockRequestFn = async (_hash: Hash, _params: Uint8Array): Promise<Uint8Array> => {
    return new Uint8Array();
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));
  const result = await executor.execute(contractHash, new Uint8Array(), [], mockRequestFn);

  assertEquals(result.dependencies.length, 2);
  assert(Hash.equals(result.dependencies[0].contractHash, dep1Hash));
  assertEquals(result.dependencies[0].params, dep1Params);
  assert(Hash.equals(result.dependencies[1].contractHash, dep2Hash));
  assertEquals(result.dependencies[1].params, dep2Params);
});

Deno.test('unknown contract throws an error', async () => {
  const unknownHash = Hash.digest('nonexistent');
  const executor = new ContractExecutor(new Map());

  await assertRejects(
    () => executor.execute(unknownHash, new Uint8Array(), []),
    Error,
    'Unknown contract',
  );
});

Deno.test('request() throws when no requestFn is provided', async () => {
  const contractHash = Hash.digest('no-request-fn');
  const otherHash = Hash.digest('other');

  const contract: ContractFn = async (ctx) => {
    await ctx.request(otherHash, new Uint8Array());
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));

  await assertRejects(
    () => executor.execute(contractHash, new Uint8Array(), []),
    Error,
    'no requestFn was provided',
  );
});

Deno.test('contract receives inputs and params', async () => {
  const contractHash = Hash.digest('input-contract');
  const inputHash = Hash.digest('input-block');
  const inputOutput = encode('input-data');
  const contractParams = encode('my-params');

  const contract: ContractFn = (ctx) => {
    assertEquals(ctx.inputs.length, 1);
    assert(Hash.equals(ctx.inputs[0].hash, inputHash));
    assertEquals(decode(ctx.inputs[0].output), 'input-data');
    assertEquals(decode(ctx.params), 'my-params');
    ctx.emit(encode('processed'));
  };

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));
  const result = await executor.execute(
    contractHash,
    contractParams,
    [{ hash: inputHash, output: inputOutput }],
  );

  assertEquals(result.outputs.length, 1);
  assertEquals(decode(result.outputs[0]), 'processed');
});

Deno.test('hasContract returns true for registered contracts', () => {
  const contractHash = Hash.digest('registered');
  const contract: ContractFn = () => {};

  const executor = new ContractExecutor(makeContractMap([[contractHash, contract]]));

  assert(executor.hasContract(contractHash));
});

Deno.test('hasContract returns false for unregistered contracts', () => {
  const unknownHash = Hash.digest('unknown');
  const executor = new ContractExecutor(new Map());

  assert(!executor.hasContract(unknownHash));
});
