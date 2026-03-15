import React, { useEffect, useState } from 'react';
import { useHighlightRegistry } from '../highlight/HighlightContext.ts';
import type { Hash } from 'scaffold.io/util/Hash.ts';

interface HashSpanProps {
  hash: Hash;
  /** Number of hex chars to show. Default 8. */
  chars?: number;
}

export const HashSpan = React.memo(function HashSpan({ hash, chars = 8 }: HashSpanProps) {
  const [highlighted, setHighlighted] = useState(false);
  const registry = useHighlightRegistry();
  const hex = hash.toHex();

  useEffect(() => {
    return registry.register(hex, setHighlighted);
  }, [registry, hex]);

  return (
    <span
      className={highlighted ? 'hash-span highlighted' : 'hash-span'}
      onMouseEnter={() => registry.setHovered([hex])}
      onMouseLeave={() => registry.setHovered([])}
      title={hex}
    >
      {hex.slice(0, chars)}…
    </span>
  );
});
