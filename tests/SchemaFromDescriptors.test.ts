import { assertEquals } from '@std/assert';
import { RecordingReader } from '../src/core/RecordingReader.ts';
import {
  descriptorToJsonSchema,
  fieldsToDefaultObject,
  yamlToBuilderValues,
} from '../explorer/src/schemaFromDescriptors.ts';
import { signatureContract } from '../src/contracts/SignatureContract.ts';
import { collateralContract } from '../src/contracts/CollateralContract.ts';
import { insuranceContract } from '../src/contracts/InsuranceContract.ts';

Deno.test('descriptorToJsonSchema: signature params produces bytes field', async () => {
  const recorder = new RecordingReader();
  await signatureContract.buildParams!(recorder.reader);
  const schema = descriptorToJsonSchema(recorder.getFields());

  assertEquals(schema.type, 'object');
  assertEquals(schema.properties.publicKey.type, 'string');
  assertEquals(schema.properties.publicKey.pattern, '^(0x([0-9a-fA-F]{2})*)?$');
});

Deno.test('descriptorToJsonSchema: collateral data produces nested structure with enums', async () => {
  const recorder = new RecordingReader();
  await collateralContract.buildData!(recorder.reader);
  const schema = descriptorToJsonSchema(recorder.getFields());

  // Side field should have enum options
  const side = schema.properties.collateral.properties.side;
  assertEquals(side.type, 'string');
  assertEquals(side.enum, ['for', 'against']);
  assertEquals(side.markdownEnumDescriptions?.length, 2);

  // Pubkey field
  const pubkey = schema.properties.collateral.properties.pubkey;
  assertEquals(pubkey.type, 'string');
  assertEquals(pubkey.pattern, '^(0x([0-9a-fA-F]{2})*)?$');
});

Deno.test('descriptorToJsonSchema: collateral AGAINST shows target fields', async () => {
  // Run builder with side=against to get conditional fields
  const values = new Map<string, unknown>();
  values.set('collateral.side', 'against');
  const recorder = new RecordingReader(values);
  await collateralContract.buildData!(recorder.reader);
  const schema = descriptorToJsonSchema(recorder.getFields());

  // Target group should exist
  const target = schema.properties.collateral.properties.target;
  assertEquals(target.type, 'object');
  assertEquals(target.properties.type.enum?.length, 5);
});

Deno.test('descriptorToJsonSchema: insurance data produces pubkey field', async () => {
  const recorder = new RecordingReader();
  await insuranceContract.buildData!(recorder.reader);
  const schema = descriptorToJsonSchema(recorder.getFields());

  assertEquals(schema.properties.pubkey.type, 'string');
  assertEquals(schema.properties.pubkey.pattern, '^(0x([0-9a-fA-F]{2})*)?$');
});

Deno.test('fieldsToDefaultObject: signature params defaults to empty hex', async () => {
  const recorder = new RecordingReader();
  await signatureContract.buildParams!(recorder.reader);
  const obj = fieldsToDefaultObject(recorder.getFields());

  assertEquals(obj.publicKey, '0x');
});

Deno.test('fieldsToDefaultObject: collateral data defaults to first enum', async () => {
  const recorder = new RecordingReader();
  await collateralContract.buildData!(recorder.reader);
  const obj = fieldsToDefaultObject(recorder.getFields());

  assertEquals(obj.collateral.side, 'for');
  assertEquals(obj.collateral.pubkey, '0x');
});

Deno.test('yamlToBuilderValues: converts hex strings to Uint8Array', async () => {
  const recorder = new RecordingReader();
  await signatureContract.buildParams!(recorder.reader);
  const fields = recorder.getFields();

  const yamlObj = { publicKey: '0xaabbcc' };
  const values = yamlToBuilderValues(yamlObj, fields);

  const pk = values.get('publicKey') as Uint8Array;
  assertEquals(pk.length, 3);
  assertEquals(pk[0], 0xaa);
  assertEquals(pk[1], 0xbb);
  assertEquals(pk[2], 0xcc);
});

Deno.test('yamlToBuilderValues: handles empty hex', async () => {
  const recorder = new RecordingReader();
  await signatureContract.buildParams!(recorder.reader);
  const fields = recorder.getFields();

  const yamlObj = { publicKey: '0x' };
  const values = yamlToBuilderValues(yamlObj, fields);

  const pk = values.get('publicKey') as Uint8Array;
  assertEquals(pk.length, 0);
});

Deno.test('yamlToBuilderValues: handles nested collateral values', async () => {
  // Discover fields with side=against and target type=ref (to get index field)
  const discover = new RecordingReader(
    new Map<string, unknown>([
      ['collateral.side', 'against'],
      ['collateral.target.type', 'ref'],
    ]),
  );
  await collateralContract.buildData!(discover.reader);
  const fields = discover.getFields();

  const yamlObj = {
    collateral: {
      side: 'against',
      pubkey: '0xaa',
      target: {
        type: 'ref',
        index: 5,
      },
    },
  };
  const values = yamlToBuilderValues(yamlObj, fields);

  assertEquals(values.get('collateral.side'), 'against');
  assertEquals((values.get('collateral.pubkey') as Uint8Array)[0], 0xaa);
  assertEquals(values.get('collateral.target.type'), 'ref');
  assertEquals(values.get('collateral.target.index'), 5);
});

Deno.test('round-trip: builder defaults -> YAML object -> builder values -> re-run builder', async () => {
  // Step 1: Run builder with defaults
  const discover = new RecordingReader();
  await signatureContract.buildParams!(discover.reader);
  const fields1 = discover.getFields();
  const defaultObj = fieldsToDefaultObject(fields1);

  // Step 2: Simulate user setting a value in YAML
  defaultObj.publicKey = '0x' + '02'.repeat(33).slice(0, 66);

  // Step 3: Convert YAML back to builder values
  const values = yamlToBuilderValues(defaultObj, fields1);

  // Step 4: Re-run builder with user values
  const builder = new RecordingReader(values);
  const result = await signatureContract.buildParams!(builder.reader);

  // The builder should have received the public key bytes
  assertEquals(result.length, 33);
  assertEquals(result[0], 0x02);
});
