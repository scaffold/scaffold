import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { ContractHost } from '../src/core/ContractHost.ts';
import { signatureContract } from '../src/contracts/SignatureContract.ts';
import { aggregationContract } from '../src/contracts/AggregationContract.ts';
import { collateralContract } from '../src/contracts/CollateralContract.ts';
import { insuranceContract } from '../src/contracts/InsuranceContract.ts';
import { recordContract } from '../src/contracts/RecordContract.ts';
import { HELLO_CONTRACT, helloContract } from '../src/contracts/HelloContract.ts';
import {
  AGGREGATION_CONTRACT,
  COLLATERAL_CONTRACT,
  INSURANCE_CONTRACT,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../src/core/Block.ts';
import type { Contract } from '../src/contracts/Contract.ts';

function namespaceHexes(host: ContractHost<unknown>, hash: Hash): string[] {
  return host.getOutputNamespaces(hash).map((h) => h.toHex());
}

Deno.test('getOutputNamespaces returns empty array for unknown contract', () => {
  const host = new ContractHost<unknown>();
  const unknown = Hash.digest('never-registered');
  assertEquals(host.getOutputNamespaces(unknown), []);
});

Deno.test('getOutputNamespaces returns empty for contract without declaration', () => {
  const host = new ContractHost<unknown>();
  const hash = Hash.digest('bare-contract');
  const bare: Contract = { run: () => {} };
  host.registerContract(hash, bare);
  assertEquals(host.getOutputNamespaces(hash), []);
});

Deno.test('standard contracts declare their output namespaces correctly', () => {
  const host = new ContractHost<unknown>();
  host.registerContract(SIGNATURE_CONTRACT, signatureContract);
  host.registerContract(AGGREGATION_CONTRACT, aggregationContract);
  host.registerContract(COLLATERAL_CONTRACT, collateralContract);
  host.registerContract(INSURANCE_CONTRACT, insuranceContract);
  host.registerContract(RECORD_CONTRACT, recordContract);
  host.registerContract(HELLO_CONTRACT, helloContract);

  assertEquals(namespaceHexes(host, SIGNATURE_CONTRACT), []);
  assertEquals(namespaceHexes(host, RECORD_CONTRACT), []);
  assertEquals(namespaceHexes(host, AGGREGATION_CONTRACT), [
    AGGREGATION_CONTRACT.toHex(),
  ]);
  assertEquals(namespaceHexes(host, INSURANCE_CONTRACT), [
    SIGNATURE_CONTRACT.toHex(),
  ]);
  assertEquals(namespaceHexes(host, COLLATERAL_CONTRACT), [
    SIGNATURE_CONTRACT.toHex(),
    RECORD_CONTRACT.toHex(),
  ]);
  assertEquals(namespaceHexes(host, HELLO_CONTRACT), [HELLO_CONTRACT.toHex()]);
});

Deno.test('custom contract can declare its own output namespace', () => {
  const host = new ContractHost<unknown>();
  const myHash = Hash.digest('my-contract');
  const target = Hash.digest('my-output-namespace');
  const mine: Contract = {
    outputNamespaces: [target],
    run: () => {},
  };
  host.registerContract(myHash, mine);
  assertEquals(namespaceHexes(host, myHash), [target.toHex()]);
});
