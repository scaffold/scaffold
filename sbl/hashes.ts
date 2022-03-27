import Hash from './util/Hash.ts';

const SBL = Hash.fromBytes(new TextEncoder().encode('SBL'.padEnd(32, '\0')));

export const timeHash = Hash.xor(SBL, Hash.fromLiteral32(1));
console.log(timeHash.toHex());
