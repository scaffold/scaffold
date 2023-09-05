import React from 'react';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';

export default ({ hash, setSelectedHash }: {
  hash: Hash;
  setSelectedHash: (primitive?: HashPrimitive) => void;
}) => (
  <span style={{ fontFamily: 'monospace' }}>
    <a
      href='#'
      onMouseOver={() => setSelectedHash(hash.toPrimitive())}
      onMouseOut={() => setSelectedHash(undefined)}
    >
      {hash.toHex().slice(0, 10)}
    </a>
  </span>
);
