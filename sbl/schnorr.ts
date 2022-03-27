import { assert } from 'https://deno.land/std@0.120.0/testing/asserts.ts';
import * as secp from 'https://deno.land/x/secp256k1/mod.ts';

const privateKey = secp.utils.randomPrivateKey();
console.log('privateKey', privateKey.length, secp.utils.bytesToHex(privateKey));
const messageHash = await secp.utils.sha256(new Uint8Array([65, 66, 67, 68]));
console.log(
  'messageHash',
  messageHash.length,
  secp.utils.bytesToHex(messageHash),
);
const publicKey = secp.getPublicKey(privateKey);
console.log('publicKey', publicKey.length, secp.utils.bytesToHex(publicKey));

const canonSig = await secp.sign(messageHash, privateKey);
console.log('canonSig', canonSig.length, secp.utils.bytesToHex(canonSig));
assert(secp.verify(canonSig, messageHash, publicKey));

// Signatures compatible with openssl
const nonCanonSig = await secp.sign(messageHash, privateKey, {
  canonical: false,
});
console.log(
  'nonCanonSig',
  nonCanonSig.length,
  secp.utils.bytesToHex(nonCanonSig),
);

// Signatures compatible with openssl
const nonDerSig = await secp.sign(messageHash, privateKey, {
  der: false,
});
console.log(
  'nonDerSig',
  nonDerSig.length,
  secp.utils.bytesToHex(nonDerSig),
);

// Supports Schnorr signatures
const schnorrPub = secp.schnorr.getPublicKey(privateKey);
console.log('schnorrPub', schnorrPub.length, secp.utils.bytesToHex(schnorrPub));

const schnorrSig = await secp.schnorr.sign(messageHash, privateKey);
console.log('schnorrSig', schnorrSig.length, secp.utils.bytesToHex(schnorrSig));

assert(await secp.schnorr.verify(schnorrSig, messageHash, schnorrPub));
