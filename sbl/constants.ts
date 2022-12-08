import Hash from './util/Hash.ts';

const SBL = Hash.fromLiteralStr('SBL'.padEnd(32, '\0'));

export const rootHash = Hash.xor(SBL, Hash.fromLiteralStr('root'));

// Simply checks that it's been signed by a public key hashing to the param
// Actually we should pass the public key of the signer to the generator/contract (like we do for the hint).
// This will allow easy-to-verify blocks like hash inversions to be authenticated.
export const accountHash = Hash.xor(SBL, Hash.fromLiteralStr('acct'));

export const loadHash = Hash.xor(SBL, Hash.fromLiteralStr('load'));

export const timeHash = Hash.xor(SBL, Hash.fromLiteralStr('time'));

export const selfHash = Hash.xor(SBL, Hash.fromLiteralStr('self'));
// Used for: timestamp, duration, inputs, licenses
