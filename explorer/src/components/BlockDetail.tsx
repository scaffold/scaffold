import React from 'react';
import { HashSpan } from './HashSpan.tsx';
import type { Block } from 'scaffold.io/core/Block.ts';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';

interface BlockDetailProps {
  block: Block;
  scaffold: Scaffold;
}

export const BlockDetail = React.memo(function BlockDetail({ block }: BlockDetailProps) {
  const zeroHex = '0'.repeat(64);
  const isGenesis = block.anchor.toHex() === zeroHex;

  return (
    <div className='block-detail'>
      <div className='detail-section'>
        <div className='detail-label'>Hash</div>
        <div className='detail-value mono'>{block.hash.toHex()}</div>
      </div>

      <div className='detail-section'>
        <div className='detail-label'>Anchor</div>
        <div className='detail-value'>
          {isGenesis
            ? <span className='muted'>Genesis</span>
            : <HashSpan hash={block.anchor} chars={16} />}
        </div>
      </div>

      {block.aggregates.length > 0 && (
        <div className='detail-section'>
          <div className='detail-label'>Aggregates ({block.aggregates.length})</div>
          <div className='detail-value'>
            {block.aggregates.map((h, i) => (
              <span key={i} style={{ marginRight: 8 }}>
                <HashSpan hash={h} />
              </span>
            ))}
          </div>
        </div>
      )}

      {block.refs.length > 0 && (
        <div className='detail-section'>
          <div className='detail-label'>Refs ({block.refs.length})</div>
          <div className='detail-value'>
            {block.refs.map((h, i) => (
              <span key={i} style={{ marginRight: 8 }}>
                <HashSpan hash={h} />
              </span>
            ))}
          </div>
        </div>
      )}

      {block.claims.length > 0 && (
        <div className='detail-section'>
          <div className='detail-label'>Claims</div>
          <div className='detail-value mono'>[{block.claims.join(', ')}]</div>
        </div>
      )}

      <div className='detail-section'>
        <div className='detail-label'>Outputs ({block.outputs.length})</div>
        <div className='detail-value'>
          {block.outputs.map((out, i) => (
            <div key={i} className='output-row'>
              <span className='output-index'>#{i}</span>
              <HashSpan hash={out.verifier.contract} chars={6} />
              <span className='output-value'>v={out.value}</span>
              <span className='muted'>{out.detail.length}B</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
