import * as avro from 'avro';

console.log(avro);

// const type = avro.parse({
//   name: 'Pet',
//   type: 'record',
//   fields: [
//     {
//       name: 'kind',
//       type: { name: 'Kind', type: 'enum', symbols: ['CAT', 'DOG'] },
//     },
//     { name: 'name', type: 'string' },
//   ],
// });
// const pet = { kind: 'CAT', name: 'Albert' };
// const buf = type.toBuffer(pet); // Serialized object.
// const obj = type.fromBuffer(buf); // {kind: 'CAT', name: 'Albert'}

const type = avro.Type.forSchema({
  type: 'record',
  name: 'Pet',
  fields: [
    {
      name: 'kind',
      type: { type: 'enum', name: 'PetKind', symbols: ['CAT', 'DOG'] },
    },
    { name: 'name', type: 'string' },
  ],
});

const buf = type.toBuffer({ kind: 'CAT', name: 'Albert' }); // Encoded buffer.
const val = type.fromBuffer(buf); // = {kind: 'CAT', name: 'Albert'}

console.log(val);
console.log(type.toString({ kind: 'CAT', name: 'Albert' }));

// const lightType = avro.Type.forSchema({
//   name: 'LightEvent',
//   aliases: ['Event'],
//   type: 'record',
//   fields: [
//     {name: 'userId', type: 'int'},
//   ]
// });

// const resolver = lightType.createResolver(heavyType);

// const schema = {
//   name: 'Transaction',
//   type: 'record',
//   fields: [
//     {name: 'amount', type: 'int'},
//     {name: 'time', type: {type: 'long', logicalType: 'timestamp-millis'}}
//   ]
// };

// const type = avro.Type.forSchema(
//   schema,
//   {logicalTypes: {'timestamp-millis': DateType}}
// );

// // We create a new transaction.
// const transaction = {
//   amount: 32,
//   time: new Date('Thu Nov 05 2015 11:38:05 GMT-0800 (PST)')
// };

// // Our type is able to directly serialize it, including the date.
// const buf = type.toBuffer(transaction);

// // And we can get the date back just as easily.
// const date = type.fromBuffer(buf).time; // `Date` object.

// const longType = avro.types.LongType.__with({
//   fromBuffer: (buf) => buf.readBigInt64LE(),
//   toBuffer: (n) => {
//     const buf = Buffer.alloc(8);
//     buf.writeBigInt64LE(n);
//     return buf;
//   },
//   fromJSON: BigInt,
//   toJSON: Number,
//   isValid: (n) => typeof n == 'bigint',
//   compare: (n1, n2) => { return n1 === n2 ? 0 : (n1 < n2 ? -1 : 1); }
// });
// const type = avro.Type.forSchema('long', {registry: {'long': longType}});

// // Round-trip of Number.MAX_SAFE_INTEGER + 4 (which is incorrectly rounded when
// // represented as a double), assuming we are using the `Long` implementation.
// const encoded = type.toBuffer(Long.fromString('9007199254740995'));
// const decoded = type.fromBuffer(encoded); // No precision loss.
