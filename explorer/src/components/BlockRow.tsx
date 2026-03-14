import React, { useEffect, useReducer, useCallback } from 'react';
import { HashSpan } from './HashSpan.tsx';
import { BlockDetail } from './BlockDetail.tsx';
import type { Block, BlockRecordSet, Scaffold } from '../types.ts';

interface BlockRowProps {
  scaffold: Scaffold;
  block: Block;
  recordSet: BlockRecordSet;
  expanded: boolean;
  pinned: boolean;
  onToggle: () => void;
  onPin: () => void;
  columns: Set<string>;
}

function formatTime(ts: number): string {
  if (ts === 0) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
}

function validityLabel(dist: { successes: number; failures: number; mean: number } | undefined): string {
  if (!dist) return '-';
  if (dist.successes === 0 && dist.failures === 0) return 'Unsampled';
  return `${(dist.mean * 100).toFixed(0)}% (${dist.successes}/${dist.successes + dist.failures})`;
}

function trustLabel(state: { forAmount: number; againstAmount: number }): string {
  if (state.forAmount === 0 && state.againstAmount === 0) return '-';
  const total = state.forAmount + state.againstAmount;
  const pct = total > 0 ? ((state.forAmount / total) * 100).toFixed(0) : '0';
  return `+${state.forAmount} -${state.againstAmount} (${pct}%)`;
}

export const BlockRow = React.memo(function BlockRow({
  scaffold,
  block,
  recordSet,
  expanded,
  pinned,
  onToggle,
  onPin,
  columns,
}: BlockRowProps) {
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    recordSet.onUpdate(block, forceUpdate);
    return () => recordSet.offUpdate(block, forceUpdate);
  }, [recordSet, block]);

  const handlePinClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onPin();
  }, [onPin]);

  // Query services directly on each render
  const { consensus, trust, sampling } = scaffold.context;
  const isCanonical = consensus.isCanonical(block.hash);
  const descendantWeight = consensus.getDescendantWeight(block.hash);
  const distribution = sampling.getDistribution(block.hash);
  const trustState = trust.getTrustState(block.hash);
  const hasConflicts = consensus.getConflicts(block.hash).size > 0;
  const throughput = block.outputs.reduce((sum, o) => sum + o.value, 0);

  return (
    <>
      <div
        className={`block-row ${isCanonical ? 'canonical' : 'non-canonical'} ${expanded ? 'expanded' : ''}`}
        onClick={onToggle}
      >
        <div className="cell cell-pin">
          <button
            className={`pin-btn ${pinned ? 'pinned' : ''}`}
            onClick={handlePinClick}
            title={pinned ? 'Unpin' : 'Pin'}
          >
            {pinned ? '\u2716' : '\u25C9'}
          </button>
        </div>

        {columns.has('hash') && (
          <div className="cell cell-hash">
            <HashSpan hash={block.hash} />
          </div>
        )}

        {columns.has('canonicality') && (
          <div className="cell cell-canonical">
            <span className={`badge ${isCanonical ? 'badge-canonical' : hasConflicts ? 'badge-conflict' : 'badge-non-canonical'}`}>
              {isCanonical ? 'Canonical' : hasConflicts ? 'Conflict' : 'Non-canon'}
            </span>
          </div>
        )}

        {columns.has('source') && (
          <div className="cell cell-source">{block.source}</div>
        )}

        {columns.has('timestamp') && (
          <div className="cell cell-time">{formatTime(block.timestamp)}</div>
        )}

        {columns.has('receivedAt') && (
          <div className="cell cell-time">{formatTime(block.receivedAt)}</div>
        )}

        {columns.has('declaredWeight') && (
          <div className="cell cell-num">{block.declaredWeight === Number.MAX_SAFE_INTEGER ? 'Genesis' : block.declaredWeight}</div>
        )}

        {columns.has('descendantWeight') && (
          <div className="cell cell-num">{descendantWeight}</div>
        )}

        {columns.has('outputs') && (
          <div className="cell cell-num">{block.outputs.length}</div>
        )}

        {columns.has('inputs') && (
          <div className="cell cell-num">{block.claims.length}</div>
        )}

        {columns.has('aggregates') && (
          <div className="cell cell-num">{block.aggregates.length}</div>
        )}

        {columns.has('throughput') && (
          <div className="cell cell-num">{throughput}</div>
        )}

        {columns.has('validity') && (
          <div className="cell cell-validity">{validityLabel(distribution)}</div>
        )}

        {columns.has('trust') && (
          <div className="cell cell-trust">{trustLabel(trustState)}</div>
        )}
      </div>

      {expanded && (
        <BlockDetail block={block} scaffold={scaffold} />
      )}
    </>
  );
});
