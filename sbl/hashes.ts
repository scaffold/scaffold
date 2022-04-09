import Hash from './util/Hash.ts';

const SBL = Hash.fromLiteralStr('SBL'.padEnd(32, '\0'));

export const loadHash = Hash.xor(SBL, Hash.fromLiteralStr('load'));
console.log('load hash:', loadHash.toHex());

export const timeHash = Hash.xor(SBL, Hash.fromLiteralStr('time'));
console.log('time hash:', timeHash.toHex());

export const selfHash = Hash.xor(SBL, Hash.fromLiteralStr('self'));
console.log('self hash:', selfHash.toHex());
// Used for: timestamp, duration, inputs, licenses
