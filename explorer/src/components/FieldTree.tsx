import React from 'react';
import type { FieldNode } from 'scaffold.io/core/RecordingWalkerHost.ts';

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function LeafValue({ node }: { node: FieldNode }) {
  switch (node.kind) {
    case 'bytes': {
      if (node.value.length === 0) {
        return <span className='muted'>empty</span>;
      }
      const hex = toHex(node.value);
      const truncated = hex.length > 16;
      return (
        <span className='byte-array' title={hex}>
          {hex.slice(0, 16)}
          {truncated && '\u2026'}
        </span>
      );
    }
    case 'string':
      return <span className='field-string'>{node.value}</span>;
    case 'number':
      return <span className='field-number'>{node.value}</span>;
    case 'bool':
      return <span className='field-bool'>{node.value ? 'true' : 'false'}</span>;
    default:
      return null;
  }
}

function FieldNodeView({ node }: { node: FieldNode }) {
  if (node.kind === 'map' || node.kind === 'list') {
    return (
      <div className='field-group'>
        {node.key && <span className='field-key'>{node.key}</span>}
        <div className='field-children'>
          {node.children.map((child, i) => <FieldNodeView key={i} node={child} />)}
        </div>
      </div>
    );
  }

  const label = node.key || node.desc.shortDescription;
  return (
    <div className='field-leaf' title={node.desc.markdownDescription ?? node.desc.shortDescription}>
      {label && <span className='field-key'>{label}</span>}
      <LeafValue node={node} />
      {node.desc.type !== 'bytes' && node.desc.type !== 'string/utf8' &&
        node.desc.type !== 'i32' && node.desc.type !== 'bool' && (
        <span className='field-type-hint'>{node.desc.type}</span>
      )}
    </div>
  );
}

export const FieldTree = React.memo(function FieldTree({ nodes }: { nodes: FieldNode[] }) {
  if (nodes.length === 0) return <span className='muted'>empty</span>;
  return (
    <div className='field-tree'>
      {nodes.map((node, i) => <FieldNodeView key={i} node={node} />)}
    </div>
  );
});
