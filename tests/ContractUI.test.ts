import { assertEquals } from '@std/assert';
import { type FieldNode, RecordingWalkerHost } from '../src/core/RecordingWalkerHost.ts';
import { DefaultBuilderHost } from '../src/core/DefaultBuilderHost.ts';
import { signatureContract } from '../src/core/SignatureContract.ts';
import { collateralContract } from '../src/core/CollateralContract.ts';
import { insuranceContract } from '../src/core/InsuranceContract.ts';
import { aggregationContract } from '../src/core/AggregationContract.ts';
import {
  type AggregationData,
  type CollateralDetail,
  decodeCollateralDetail,
  decodeInsuranceDetail,
  encodeAggregationData,
  encodeCollateralDetail,
  encodeInsuranceDetail,
  type InsuranceDetail,
} from '../src/core/Block.ts';

// -- Helpers ----------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// =====================================================================
// RecordingWalkerHost tests
// =====================================================================

Deno.test('RecordingWalkerHost: emits a single bytes field', () => {
  const host = new RecordingWalkerHost();
  const pubkey = new Uint8Array(33).fill(0xab);
  signatureContract.walkParams!(pubkey, host);
  const tree = host.getTree();
  assertEquals(tree.length, 1);
  assertEquals(tree[0].kind, 'bytes');
  if (tree[0].kind === 'bytes') {
    assertEquals(tree[0].key, '');
    assertEquals(bytesEqual(tree[0].value, pubkey), true);
    assertEquals(tree[0].desc.type, 'bytes/public_key/ed25519');
  }
});

Deno.test('RecordingWalkerHost: emits nested map structure for FOR collateral', () => {
  const host = new RecordingWalkerHost();
  const detail: CollateralDetail = {
    side: 'for',
    pubkey: new Uint8Array(33).fill(0x01),
  };
  const data = encodeCollateralDetail(detail);
  collateralContract.walkData!(data, host);
  const tree = host.getTree();
  assertEquals(tree.length, 1);
  assertEquals(tree[0].kind, 'map');
  if (tree[0].kind === 'map') {
    assertEquals(tree[0].key, 'collateral');
    // FOR side: should have side + pubkey, no target
    assertEquals(tree[0].children.length, 2);
    assertEquals(tree[0].children[0].kind, 'string');
    if (tree[0].children[0].kind === 'string') {
      assertEquals(tree[0].children[0].key, 'side');
      assertEquals(tree[0].children[0].value, 'for');
    }
    assertEquals(tree[0].children[1].kind, 'bytes');
    if (tree[0].children[1].kind === 'bytes') {
      assertEquals(tree[0].children[1].key, 'pubkey');
    }
  }
});

Deno.test('RecordingWalkerHost: emits conditional fields for against side', () => {
  const host = new RecordingWalkerHost();
  const detail: CollateralDetail = {
    side: 'against',
    pubkey: new Uint8Array(33).fill(0x02),
    target: { type: 'ref', index: 3 },
  };
  const data = encodeCollateralDetail(detail);
  collateralContract.walkData!(data, host);
  const tree = host.getTree();
  assertEquals(tree.length, 1);
  assertEquals(tree[0].kind, 'map');
  if (tree[0].kind === 'map') {
    // AGAINST side: should have side + pubkey + target map
    assertEquals(tree[0].children.length, 3);
    const targetNode = tree[0].children[2];
    assertEquals(targetNode.kind, 'map');
    if (targetNode.kind === 'map') {
      assertEquals(targetNode.key, 'target');
      // target has type + index
      assertEquals(targetNode.children.length, 2);
      if (targetNode.children[0].kind === 'string') {
        assertEquals(targetNode.children[0].value, 'ref');
      }
      if (targetNode.children[1].kind === 'number') {
        assertEquals(targetNode.children[1].key, 'index');
        assertEquals(targetNode.children[1].value, 3);
      }
    }
  }
});

Deno.test('RecordingWalkerHost: emits list fields for aggregation data', () => {
  const host = new RecordingWalkerHost();
  const aggData: AggregationData = {
    claimMask: [0, 2, 5],
    newOutputCount: 7,
    aggregateOutputCounts: [3, 4],
    chainWeights: [10, 20],
    aggregateWeights: [5, 15],
  };
  const data = encodeAggregationData(aggData);
  aggregationContract.walkData!(data, host);
  const tree = host.getTree();

  // claimMask list, newOutputCount number, aggregateOutputCounts list,
  // chainWeights list, aggregateWeights list
  assertEquals(tree.length, 5);

  // claimMask
  assertEquals(tree[0].kind, 'list');
  if (tree[0].kind === 'list') {
    assertEquals(tree[0].key, 'claimMask');
    assertEquals(tree[0].count, 3);
    assertEquals(tree[0].children.length, 3);
  }

  // newOutputCount
  assertEquals(tree[1].kind, 'number');
  if (tree[1].kind === 'number') {
    assertEquals(tree[1].key, 'newOutputCount');
    assertEquals(tree[1].value, 7);
  }

  // chainWeights
  assertEquals(tree[3].kind, 'list');
  if (tree[3].kind === 'list') {
    assertEquals(tree[3].key, 'chainWeights');
    assertEquals(tree[3].count, 2);
    assertEquals(tree[3].children.length, 2);
    if (tree[3].children[0].kind === 'number') {
      assertEquals(tree[3].children[0].value, 10);
    }
  }
});

Deno.test('RecordingWalkerHost: emits insurance data', () => {
  const host = new RecordingWalkerHost();
  const detail: InsuranceDetail = {
    pubkey: new Uint8Array(33).fill(0xcc),
  };
  const data = encodeInsuranceDetail(detail);
  insuranceContract.walkData!(data, host);
  const tree = host.getTree();
  assertEquals(tree.length, 1);
  assertEquals(tree[0].kind, 'bytes');
  if (tree[0].kind === 'bytes') {
    assertEquals(tree[0].key, 'pubkey');
    assertEquals(tree[0].desc.type, 'bytes/public_key/ed25519');
    assertEquals(bytesEqual(tree[0].value, detail.pubkey), true);
  }
});

// =====================================================================
// DefaultBuilderHost tests
// =====================================================================

Deno.test('DefaultBuilderHost: returns default values when no user input', () => {
  const host = new DefaultBuilderHost();
  const result = signatureContract.buildParams!(host);
  // Default is empty bytes
  assertEquals(result.length, 0);
  // No validation error for empty bytes (length > 0 check skipped)
  assertEquals(host.getErrors().length, 0);
});

Deno.test('DefaultBuilderHost: returns user-provided values', () => {
  const pubkey = new Uint8Array(33).fill(0xab);
  const values = new Map<string, unknown>();
  values.set('publicKey', pubkey);
  const host = new DefaultBuilderHost(values);
  const result = signatureContract.buildParams!(host);
  assertEquals(bytesEqual(result, pubkey), true);
});

Deno.test('DefaultBuilderHost: returns first enum option as default for strings', () => {
  const host = new DefaultBuilderHost();
  const result = collateralContract.buildData!(host);
  // Default side should be 'for' (first enum option)
  const detail = decodeCollateralDetail(result);
  assertEquals(detail.side, 'for');
});

Deno.test('DefaultBuilderHost: records field requests in order', () => {
  const host = new DefaultBuilderHost();
  collateralContract.buildData!(host);
  const fields = host.getFields();
  // With default 'for' side: side, pubkey (no target fields)
  assertEquals(fields.length, 2);
  assertEquals(fields[0].key, 'side');
  assertEquals(fields[0].kind, 'string');
  assertEquals(fields[0].path, ['collateral', 'side']);
  assertEquals(fields[1].key, 'pubkey');
  assertEquals(fields[1].kind, 'bytes');
  assertEquals(fields[1].path, ['collateral', 'pubkey']);
});

Deno.test('DefaultBuilderHost: records validation errors', () => {
  // Provide a public key that is not 33 bytes and not empty
  const badKey = new Uint8Array(10).fill(0x01);
  const values = new Map<string, unknown>();
  values.set('publicKey', badKey);
  const host = new DefaultBuilderHost(values);
  signatureContract.buildParams!(host);
  const errors = host.getErrors();
  assertEquals(errors.length, 1);
  assertEquals(errors[0].key, 'publicKey');
  assertEquals(errors[0].message, 'Public key must be 33 bytes');
});

// =====================================================================
// Round-trip tests
// =====================================================================

Deno.test('Round-trip: signature params through walk then build', () => {
  const originalParams = new Uint8Array(33).fill(0x42);

  // Walk the original params
  const walker = new RecordingWalkerHost();
  signatureContract.walkParams!(originalParams, walker);
  const tree = walker.getTree();

  // Extract walked value and build with it
  assertEquals(tree[0].kind, 'bytes');
  const walkedValue = (tree[0] as { kind: 'bytes'; value: Uint8Array }).value;

  const values = new Map<string, unknown>();
  values.set('publicKey', walkedValue);
  const builder = new DefaultBuilderHost(values);
  const builtParams = signatureContract.buildParams!(builder);

  assertEquals(bytesEqual(builtParams, originalParams), true);
});

Deno.test('Round-trip: collateral FOR data', () => {
  const original: CollateralDetail = {
    side: 'for',
    pubkey: new Uint8Array(33).fill(0x11),
  };
  const originalData = encodeCollateralDetail(original);

  // Walk to extract values
  const walker = new RecordingWalkerHost();
  collateralContract.walkData!(originalData, walker);
  const tree = walker.getTree();

  // Extract from walked tree
  assertEquals(tree[0].kind, 'map');
  const mapNode = tree[0] as { kind: 'map'; children: FieldNode[] };
  const sideNode = mapNode.children[0] as { kind: 'string'; value: string };
  const pubkeyNode = mapNode.children[1] as { kind: 'bytes'; value: Uint8Array };

  // Build with walked values
  const values = new Map<string, unknown>();
  values.set('collateral.side', sideNode.value);
  values.set('collateral.pubkey', pubkeyNode.value);
  const builder = new DefaultBuilderHost(values);
  const builtData = collateralContract.buildData!(builder);

  // Verify decoded result matches original
  const decoded = decodeCollateralDetail(builtData);
  assertEquals(decoded.side, original.side);
  assertEquals(bytesEqual(decoded.pubkey, original.pubkey), true);
});

Deno.test('Round-trip: collateral AGAINST data', () => {
  const original: CollateralDetail = {
    side: 'against',
    pubkey: new Uint8Array(33).fill(0x22),
    target: { type: 'ref', index: 5 },
  };
  const originalData = encodeCollateralDetail(original);

  // Walk to extract values
  const walker = new RecordingWalkerHost();
  collateralContract.walkData!(originalData, walker);
  const tree = walker.getTree();

  // Extract from walked tree
  const mapNode = tree[0] as { kind: 'map'; children: FieldNode[] };
  const sideNode = mapNode.children[0] as { kind: 'string'; value: string };
  const pubkeyNode = mapNode.children[1] as { kind: 'bytes'; value: Uint8Array };
  const targetNode = mapNode.children[2] as { kind: 'map'; children: FieldNode[] };
  const typeNode = targetNode.children[0] as { kind: 'string'; value: string };
  const indexNode = targetNode.children[1] as { kind: 'number'; value: number };

  // Build with walked values
  const values = new Map<string, unknown>();
  values.set('collateral.side', sideNode.value);
  values.set('collateral.pubkey', pubkeyNode.value);
  values.set('collateral.target.type', typeNode.value);
  values.set('collateral.target.index', indexNode.value);
  const builder = new DefaultBuilderHost(values);
  const builtData = collateralContract.buildData!(builder);

  // Verify decoded result matches original
  const decoded = decodeCollateralDetail(builtData);
  assertEquals(decoded.side, 'against');
  if (decoded.side === 'against') {
    assertEquals(bytesEqual(decoded.pubkey, original.pubkey), true);
    assertEquals(decoded.target.type, 'ref');
    if (decoded.target.type === 'ref') {
      assertEquals(decoded.target.index, 5);
    }
  }
});

Deno.test('Round-trip: insurance data', () => {
  const original: InsuranceDetail = {
    pubkey: new Uint8Array(33).fill(0x33),
  };
  const originalData = encodeInsuranceDetail(original);

  // Walk to extract values
  const walker = new RecordingWalkerHost();
  insuranceContract.walkData!(originalData, walker);
  const tree = walker.getTree();

  // Extract walked pubkey
  assertEquals(tree[0].kind, 'bytes');
  const pubkeyNode = tree[0] as { kind: 'bytes'; value: Uint8Array };

  // Build with walked values
  const values = new Map<string, unknown>();
  values.set('pubkey', pubkeyNode.value);
  const builder = new DefaultBuilderHost(values);
  const builtData = insuranceContract.buildData!(builder);

  // Verify decoded result matches original
  const decoded = decodeInsuranceDetail(builtData);
  assertEquals(bytesEqual(decoded.pubkey, original.pubkey), true);
});
