import React, { useMemo } from 'react';
import { HighlightRegistry } from '../highlight/HighlightRegistry.ts';
import { HighlightContext } from '../highlight/HighlightContext.ts';
import { BlockGraph } from './BlockGraph.tsx';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';
import type { InitialClaim } from './BlockCreationModal.tsx';

interface BlockGraphExplorerProps {
  scaffold: Scaffold;
  onCreateBlock?: (claims?: InitialClaim[]) => void;
}

export function BlockGraphExplorer(
  { scaffold, onCreateBlock }: BlockGraphExplorerProps,
) {
  const registry = useMemo(() => new HighlightRegistry(), []);

  return (
    <HighlightContext.Provider value={registry}>
      <div className='block-graph-explorer'>
        <div className='explorer-header'>
          <h1>Block Graph Explorer</h1>
        </div>
        <BlockGraph scaffold={scaffold} onCreateBlock={onCreateBlock} />
      </div>
    </HighlightContext.Provider>
  );
}
