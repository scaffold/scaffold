import React from 'react';
import { ByteArray } from './ByteArray.tsx';
import { getContractName } from '../contracts.ts';
import type { Block } from 'scaffold.io/core/Block.ts';
import type { Output } from 'scaffold.io/core/BlockCreationModule.ts';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';

const ZERO_HEX = '0'.repeat(64);

interface BlockGraphDetailProps {
  hash: string;
  scaffold: Scaffold;
  pinned: boolean;
  onClose: () => void;
  onPin: () => void;
  onNavigate: (hex: string) => void;
}

function ClickableHash(
  { hex, scaffold, onNavigate }: {
    hex: string;
    scaffold: Scaffold;
    onNavigate: (hex: string) => void;
  },
) {
  const exists = scaffold.context.store.get(
    // Check by looking up in blocks
    (() => {
      for (const b of scaffold.blocks.getAll()) {
        if (b.hash.toHex() === hex) return b.hash;
      }
      return undefined!;
    })(),
  );

  if (exists) {
    return (
      <span className="clickable-hash" onClick={() => onNavigate(hex)} title={hex}>
        {hex.slice(0, 12)}…
      </span>
    );
  }
  return (
    <span className="hash-span" title={hex}>
      {hex.slice(0, 12)}…
    </span>
  );
}

function OutputEntry({ output, index }: { output: Output; index: number }) {
  const contractName = getContractName(output.verifier.contract);
  return (
    <div className="output-row">
      <span className="output-index">#{index}</span>
      {contractName
        ? <span className="contract-name">{contractName}</span>
        : (
          <span className="hash-span" title={output.verifier.contract.toHex()}>
            {output.verifier.contract.toHex().slice(0, 6)}…
          </span>
        )}
      <ByteArray bytes={output.verifier.params} />
      <span className="output-value">v={output.value}</span>
      {output.detail.length > 0
        ? <ByteArray bytes={output.detail} />
        : <span className="muted">0B</span>}
    </div>
  );
}

function ClaimEntry(
  { block, claimIndex, anchorBlock }: {
    block: Block;
    claimIndex: number;
    anchorBlock: Block | undefined;
  },
) {
  const ownCount = block.outputs.length;
  let output: Output | undefined;
  let label: string;

  if (claimIndex < ownCount) {
    output = block.outputs[claimIndex];
    label = `self #${claimIndex}`;
  } else {
    const anchorIdx = claimIndex - ownCount;
    output = anchorBlock?.outputs[anchorIdx];
    label = `#${anchorIdx}`;
  }

  if (!output) {
    return (
      <div className="output-row">
        <span className="output-index">{label}</span>
        <span className="muted">Unresolved</span>
      </div>
    );
  }

  const contractName = getContractName(output.verifier.contract);
  return (
    <div className="output-row">
      <span className="output-index">{label}</span>
      {contractName
        ? <span className="contract-name">{contractName}</span>
        : (
          <span className="hash-span" title={output.verifier.contract.toHex()}>
            {output.verifier.contract.toHex().slice(0, 6)}…
          </span>
        )}
      <ByteArray bytes={output.verifier.params} />
      <span className="output-value">v={output.value}</span>
      {output.detail.length > 0
        ? <ByteArray bytes={output.detail} />
        : <span className="muted">0B</span>}
    </div>
  );
}

export const BlockGraphDetail = React.memo(function BlockGraphDetail(
  { hash, scaffold, pinned, onClose, onPin, onNavigate }: BlockGraphDetailProps,
) {
  const ctx = scaffold.context;
  const consensus = ctx.consensus;

  // Find block
  let block: Block | undefined;
  for (const b of scaffold.blocks.getAll()) {
    if (b.hash.toHex() === hash) {
      block = b;
      break;
    }
  }
  if (!block) return null;

  const isGenesis = block.anchor.toHex() === ZERO_HEX;
  const isCanonical = consensus.isCanonical(block.hash);
  const conflicts = consensus.getConflicts(block.hash);
  const hasConflicts = conflicts.size > 1;
  const descendantWeight = consensus.getDescendantWeight(block.hash);
  const effectiveWeight = consensus.getEffectiveWeight(block.hash);

  const anchorBlock = !isGenesis ? ctx.store.get(block.anchor) : undefined;

  const statusClass = hasConflicts ? 'conflict' : isCanonical ? 'canonical' : 'non-canonical';
  const statusLabel = hasConflicts ? 'Conflict' : isCanonical ? 'Canonical' : 'Non-canonical';

  return (
    <div className="graph-detail-panel">
      <div className="graph-detail-header">
        <span className="graph-detail-title">Block Detail</span>
        <div className="graph-detail-actions">
          <button
            className={`pin-btn${pinned ? ' pinned' : ''}`}
            onClick={onPin}
            title={pinned ? 'Unpin' : 'Pin'}
          >
            {pinned ? '\u2605' : '\u2606'}
          </button>
          <button className="graph-detail-close" onClick={onClose}>×</button>
        </div>
      </div>

      <div className="graph-detail-body">
        <div className="detail-section">
          <div className="detail-label">Hash</div>
          <div className="detail-value mono" style={{ fontSize: 11 }}>{hash}</div>
        </div>

        <div className="detail-section">
          <div className="detail-label">Status</div>
          <div className="detail-value">
            <span className={`badge badge-${statusClass}`}>{statusLabel}</span>
          </div>
        </div>

        <div className="detail-section">
          <div className="detail-label">Anchor</div>
          <div className="detail-value">
            {isGenesis
              ? <span className="muted">Genesis</span>
              : (
                <ClickableHash
                  hex={block.anchor.toHex()}
                  scaffold={scaffold}
                  onNavigate={onNavigate}
                />
              )}
          </div>
        </div>

        <div className="detail-section">
          <div className="detail-label">Weight</div>
          <div className="detail-value mono" style={{ fontSize: 12 }}>
            declared: {block.declaredWeight}
            {' / '}
            descendant: {descendantWeight}
            {' / '}
            effective: {effectiveWeight}
          </div>
        </div>

        {block.aggregates.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">Aggregates ({block.aggregates.length})</div>
            <div className="detail-value">
              {block.aggregates.map((h, i) => (
                <span key={i} style={{ marginRight: 6, display: 'inline-block' }}>
                  <ClickableHash
                    hex={h.toHex()}
                    scaffold={scaffold}
                    onNavigate={onNavigate}
                  />
                </span>
              ))}
            </div>
          </div>
        )}

        {block.refs.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">Refs ({block.refs.length})</div>
            <div className="detail-value">
              {block.refs.map((h, i) => (
                <span key={i} style={{ marginRight: 6, display: 'inline-block' }}>
                  <ClickableHash
                    hex={h.toHex()}
                    scaffold={scaffold}
                    onNavigate={onNavigate}
                  />
                </span>
              ))}
            </div>
          </div>
        )}

        {block.claims.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">Claims ({block.claims.length})</div>
            <div className="detail-value">
              {block.claims.map((ci, i) => (
                <ClaimEntry
                  key={i}
                  block={block!}
                  claimIndex={ci}
                  anchorBlock={anchorBlock}
                />
              ))}
            </div>
          </div>
        )}

        <div className="detail-section">
          <div className="detail-label">Outputs ({block.outputs.length})</div>
          <div className="detail-value">
            {block.outputs.map((out, i) => (
              <OutputEntry key={i} output={out} index={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
