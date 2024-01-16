// declare global {
//   interface Crypto {
//     randomUUID: () => string;
//   }
// }

import * as secp from 'secp256k1';

// Uncaught RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than 4KB. Use WebAssembly.compile, or compile on a worker thread.
// import { crypto } from 'std-latest/crypto/mod.ts';
import { HmacSha256 } from 'https://deno.land/std@0.160.0/hash/sha256.ts';

secp.etc.hmacSha256Sync = (key, ...msgs) => {
  const algo = new HmacSha256(key);
  msgs.forEach((msg) => algo.update(msg));
  return new Uint8Array(algo.digest());
};

export default secp;

// // We need this until https://github.com/paulmillr/noble-secp256k1/pull/100
// import { etc } from 'https://deno.land/x/secp256k1@2.0.0/index.ts';

// export default { ...secp, etc };
