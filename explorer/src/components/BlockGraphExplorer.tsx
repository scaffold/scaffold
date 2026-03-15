import React, { useMemo } from "react";
import { HighlightRegistry } from "../highlight/HighlightRegistry.ts";
import { HighlightContext } from "../highlight/HighlightContext.ts";
import { BlockGraph } from "./BlockGraph.tsx";
import type { Scaffold } from "scaffold.io/Scaffold.ts";

interface BlockGraphExplorerProps {
  scaffold: Scaffold;
}

export function BlockGraphExplorer({ scaffold }: BlockGraphExplorerProps) {
  const registry = useMemo(() => new HighlightRegistry(), []);

  return (
    <HighlightContext.Provider value={registry}>
      <div className="block-graph-explorer">
        <div className="explorer-header">
          <h1>Block Graph Explorer</h1>
        </div>
        <BlockGraph scaffold={scaffold} />
      </div>
    </HighlightContext.Provider>
  );
}
