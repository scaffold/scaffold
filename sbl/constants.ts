import Hash from './util/Hash.ts';

const SBL = Hash.fromLiteralStr('SBL'.padEnd(32, '\0'));

// TODO: Call this dataHash
export const rootHash = Hash.xor(SBL, Hash.fromLiteralStr('root'));

export const trueHash = Hash.xor(SBL, Hash.fromLiteralStr('true'));
export const falseHash = Hash.xor(SBL, Hash.fromLiteralStr('false'));

export const generatorHash = Hash.xor(SBL, Hash.fromLiteralStr('gen'));

// TODO: Call this something else (we might not even need it)
export const dataHash = Hash.xor(SBL, Hash.fromLiteralStr('data'));

export const collateralHash = Hash.xor(SBL, Hash.fromLiteralStr('collateral'));
// export const collateralInitHash = Hash.xor(
//   SBL,
//   Hash.fromLiteralStr('collateral_init'),
// );
// export const collateralContestionHash = Hash.xor(
//   SBL,
//   Hash.fromLiteralStr('collateral_contestion'),
// );
// export const collateralVoteHash = Hash.xor(
//   SBL,
//   Hash.fromLiteralStr('collateral_vote'),
// );

export const hintHash = Hash.xor(SBL, Hash.fromLiteralStr('hint'));

// export const voteHash = Hash.xor(SBL, Hash.fromLiteralStr('vote'));

export const epochHash = Hash.xor(SBL, Hash.fromLiteralStr('epoch'));

export const epochInclusionHash = Hash.xor(
  SBL,
  Hash.fromLiteralStr('epochInclusion'),
);

// Simply checks that it's been signed by a public key hashing to the param
// Actually we should pass the public key of the signer to the generator/contract (like we do for the hint).
// This will allow easy-to-verify blocks like hash inversions to be authenticated.
export const accountHash = Hash.xor(SBL, Hash.fromLiteralStr('account'));

export const loadHash = Hash.xor(SBL, Hash.fromLiteralStr('load'));

export const timeHash = Hash.xor(SBL, Hash.fromLiteralStr('time'));

export const selfHash = Hash.xor(SBL, Hash.fromLiteralStr('self'));
// Used for: timestamp, duration, inputs, licenses

export const jsWasiHash = Hash.xor(SBL, Hash.fromLiteralStr('js_wasi'));
export const jsLockHash = Hash.xor(SBL, Hash.fromLiteralStr('js_lock'));
