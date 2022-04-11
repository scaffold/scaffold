import Hash from './util/Hash.ts';

const SBL = Hash.fromLiteralStr('SBL'.padEnd(32, '\0'));

export const loadHash = Hash.xor(SBL, Hash.fromLiteralStr('load'));

export const timeHash = Hash.xor(SBL, Hash.fromLiteralStr('time'));

export const selfHash = Hash.xor(SBL, Hash.fromLiteralStr('self'));
// Used for: timestamp, duration, inputs, licenses
