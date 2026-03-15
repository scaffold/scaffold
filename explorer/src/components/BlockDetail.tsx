import React from "react";
import { HashSpan } from "./HashSpan.tsx";
import { ByteArray } from "./ByteArray.tsx";
import { getContractName } from "../contracts.ts";
import type { Block } from "scaffold.io/core/Block.ts";
import type { Output } from "scaffold.io/core/BlockCreationModule.ts";
import type { Scaffold } from "scaffold.io/Scaffold.ts";

interface BlockDetailProps {
  block: Block;
  scaffold: Scaffold;
}

function OutputEntry({ output, index }: { output: Output; index: number }) {
  const contractName = getContractName(output.verifier.contract);
  return (
    <div className="output-row">
      <span className="output-index">#{index}</span>
      {contractName
        ? <span className="contract-name">{contractName}</span>
        : <HashSpan hash={output.verifier.contract} chars={6} />}
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
        : <HashSpan hash={output.verifier.contract} chars={6} />}
      <ByteArray bytes={output.verifier.params} />
      <span className="output-value">v={output.value}</span>
      {output.detail.length > 0
        ? <ByteArray bytes={output.detail} />
        : <span className="muted">0B</span>}
    </div>
  );
}

export const BlockDetail = React.memo(
  function BlockDetail({ block, scaffold }: BlockDetailProps) {
    const zeroHex = "0".repeat(64);
    const isGenesis = block.anchor.toHex() === zeroHex;
    const anchorBlock = !isGenesis
      ? scaffold.context.store.get(block.anchor)
      : undefined;

    return (
      <div className="block-detail">
        <div className="detail-section">
          <div className="detail-label">Hash</div>
          <div className="detail-value mono">{block.hash.toHex()}</div>
        </div>

        <div className="detail-section">
          <div className="detail-label">Anchor</div>
          <div className="detail-value">
            {isGenesis
              ? <span className="muted">Genesis</span>
              : <HashSpan hash={block.anchor} chars={16} />}
          </div>
        </div>

        {block.aggregates.length > 0 && (
          <div className="detail-section">
            <div className="detail-label">
              Aggregates ({block.aggregates.length})
            </div>
            <div className="detail-value">
              {block.aggregates.map((h, i) => (
                <span key={i} style={{ marginRight: 8 }}>
                  <HashSpan hash={h} />
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
                <span key={i} style={{ marginRight: 8 }}>
                  <HashSpan hash={h} />
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
                  block={block}
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
    );
  },
);
