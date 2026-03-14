import React, { useMemo, useCallback, useState } from 'react';
import { BlockGraphExplorer } from '@scaffold/explorer';
import { createMockScaffold } from './MockScaffold.ts';

export function App() {
  const scaffold = useMemo(() => createMockScaffold(), []);
  const [count, setCount] = useState(0);

  const handleAddBlock = useCallback(() => {
    scaffold.addBlock();
    setCount((c) => c + 1);
  }, [scaffold]);

  const handleAdd5 = useCallback(() => {
    for (let i = 0; i < 5; i++) scaffold.addBlock();
    setCount((c) => c + 5);
  }, [scaffold]);

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f7' }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 24px',
        background: 'rgba(255, 255, 255, 0.72)',
        backdropFilter: 'saturate(180%) blur(20px)',
        WebkitBackdropFilter: 'saturate(180%) blur(20px)',
        borderBottom: '1px solid rgba(0, 0, 0, 0.1)',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        <span style={{
          fontSize: 15,
          fontWeight: 700,
          color: '#1d1d1f',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          letterSpacing: '-0.02em',
        }}>
          Scaffold
        </span>
        <span style={{
          width: 1,
          height: 20,
          background: '#d2d2d7',
          margin: '0 4px',
        }} />
        <button onClick={handleAddBlock} style={btnStyle}>
          Add Block
        </button>
        <button onClick={handleAdd5} style={{ ...btnStyle, background: '#f5f5f7', color: '#1d1d1f', border: '1px solid #d2d2d7' }}>
          Add 5
        </button>
        <span style={{ fontSize: 12, color: '#8e8e93', fontFamily: '-apple-system, sans-serif' }}>
          {count > 0 ? `+${count} added` : 'Click to simulate receiving blocks'}
        </span>
      </div>

      <BlockGraphExplorer scaffold={scaffold as any} />
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 16px',
  background: '#0071e3',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  transition: 'opacity 0.15s',
  lineHeight: '20px',
};
