import React, { useMemo, useCallback } from 'react';
import { BlockGraphExplorer } from '@scaffold/explorer';
import { createMockScaffold } from './MockScaffold.ts';

export function App() {
  const scaffold = useMemo(() => createMockScaffold(), []);

  const handleAddBlock = useCallback(() => {
    scaffold.addBlock();
  }, [scaffold]);

  return (
    <div>
      <div style={{
        padding: '12px 24px',
        background: '#fff',
        borderBottom: '1px solid #d2d2d7',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}>
        <button
          onClick={handleAddBlock}
          style={{
            padding: '6px 16px',
            background: '#0071e3',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Add Block
        </button>
        <span style={{ fontSize: 12, color: '#8e8e93' }}>
          Click to simulate receiving a new block
        </span>
      </div>
      <BlockGraphExplorer scaffold={scaffold as any} />
    </div>
  );
}
