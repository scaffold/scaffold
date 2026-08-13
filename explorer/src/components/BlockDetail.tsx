import React from 'react';
import { HashSpan } from './HashSpan.tsx';
import { ByteArray } from './ByteArray.tsx';
import { FieldTree } from './FieldTree.tsx';
import { getContract, getContractName } from '../contracts.ts';
import { RecordingWalkerHost } from 'scaffold.io/core/RecordingWalkerHost.ts';
import type { FieldNode } from 'scaffold.io/core/RecordingWalkerHost.ts';
import type { Block } from 'scaffold.io/core/Block.ts';
import type { Output } from 'scaffold.io/core/BlockCreationModule.ts';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';
import type { Hash } from 'scaffold.io/util/Hash.ts';

interface BlockDetailProps {
  block: Block;
  scaffold: Scaffold;
}

function walkParams(contractHash: Hash, params: Uint8Array): FieldNode[] | null {
  const contract = getContract(contractHash);
  if (!contract?.walkParams) return null;
  const host = new RecordingWalkerHost();
  contract.walkParams(params, host);
  return host.getTree();
}

function walkData(contractHash: Hash, data: Uint8Array): FieldNode[] | null {
  if (data.length === 0) return null;
  const contract = getContract(contractHash);
  if (!contract?.walkData) return null;
  try {
    const host = new RecordingWalkerHost();
    contract.walkData(data, host);
    return host.getTree();
  } catch {
    return null;
  }
}

function WalkedParams({ contractHash, params }: { contractHash: Hash; params: Uint8Array }) {
  const tree = walkParams(contractHash, params);
  if (tree && tree.length > 0) return <FieldTree nodes={tree} />;
  return <ByteArray bytes={params} />;
}

function WalkedData({ contractHash, data }: { contractHash: Hash; data: Uint8Array }) {
  if (data.length === 0) return <span className='muted'>0B</span>;
  const tree = walkData(contractHash, data);
  if (tree && tree.length > 0) return <FieldTree nodes={tree} />;
  return <ByteArray bytes={data} />;
}

function OutputEntry({ output, index }: { output: Output; index: number }) {
  const contractName = getContractName(output.verifier.contract);
  return (
    <div className='output-row'>
      <span className='output-index'>#{index}</span>
      {contractName
        ? <span className='contract-name'>{contractName}</span>
        : <HashSpan hash={output.verifier.contract} chars={6} />}
      <WalkedParams contractHash={output.verifier.contract} params={output.verifier.params} />
      <span className='output-value'>v={output.value}</span>
      <WalkedData contractHash={output.verifier.contract} data={output.data} />
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
      <div className='output-row'>
        <span className='output-index'>{label}</span>
        <span className='muted'>Unresolved</span>
      </div>
    );
  }

  const contractName = getContractName(output.verifier.contract);
  return (
    <div className='output-row'>
      <span className='output-index'>{label}</span>
      {contractName
        ? <span className='contract-name'>{contractName}</span>
        : <HashSpan hash={output.verifier.contract} chars={6} />}
      <WalkedParams contractHash={output.verifier.contract} params={output.verifier.params} />
      <span className='output-value'>v={output.value}</span>
      <WalkedData contractHash={output.verifier.contract} data={output.data} />
    </div>
  );
}

export const BlockDetail = React.memo(
  function BlockDetail({ block, scaffold }: BlockDetailProps) {
    const zeroHex = '0'.repeat(64);
    const isGenesis = block.anchor.toHex() === zeroHex;
    const anchorBlock = !isGenesis ? scaffold.context.store.get(block.anchor) : undefined;

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
            <div className='detail-label'>
              Aggregates ({block.aggregates.length})
            </div>
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
            <div className='detail-label'>Claims ({block.claims.length})</div>
            <div className='detail-value'>
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

        <div className='detail-section'>
          <div className='detail-label'>Outputs ({block.outputs.length})</div>
          <div className='detail-value'>
            {block.outputs.map((out, i) => <OutputEntry key={i} output={out} index={i} />)}
          </div>
        </div>
      </div>
    );
  },
);
