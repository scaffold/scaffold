declare global {
  interface Crypto {
    randomUUID: () => string;
  }
}

import * as secp from 'secp256k1';
export default secp;
