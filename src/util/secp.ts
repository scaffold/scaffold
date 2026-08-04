import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

// secp256k1 v3 carries no hash implementation of its own -- the synchronous
// sign/verify/recover paths throw until these are wired up.
secp.hashes.sha256 = sha256;
secp.hashes.hmacSha256 = (key, message) => hmac(sha256, key, message);

export { secp };
