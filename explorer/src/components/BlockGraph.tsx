import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { select } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import type { ZoomBehavior, ZoomTransform } from 'd3-zoom';
import { useHighlightRegistry } from '../highlight/HighlightContext.ts';
import { BlockGraphDetail } from './BlockGraphDetail.tsx';
import type { Block } from 'scaffold.io/core/Block.ts';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';

// -- Types ------------------------------------------------------------------

interface GraphNode extends SimulationNodeDatum {
  id: string;
  block: Block;
  targetX: number;
  targetY: number;
  isCanonical: boolean;
  hasConflicts: boolean;
  descendantWeight: number;
  effectiveWeight: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  type: 'anchor' | 'aggregate' | 'ref';
}

// -- Constants --------------------------------------------------------------

const NODE_WIDTH = 140;
const NODE_HEIGHT = 56;
const PADDING = 60;

const ZERO_HEX = '0'.repeat(64);

// -- Helpers ----------------------------------------------------------------

function computeGraphData(
  blocks: Block[],
  scaffold: Scaffold,
): { nodes: GraphNode[]; links: GraphLink[]; width: number; height: number } {
  const ctx = scaffold.context;
  const consensus = ctx.consensus;
  const blocksByHex = new Map<string, Block>();
  for (const b of blocks) blocksByHex.set(b.hash.toHex(), b);

  // Compute weights and status
  const nodeData: {
    hex: string;
    block: Block;
    isCanonical: boolean;
    hasConflicts: boolean;
    descendantWeight: number;
    effectiveWeight: number;
  }[] = [];

  for (const block of blocks) {
    const hex = block.hash.toHex();
    const isCanonical = consensus.isCanonical(block.hash);
    const conflicts = consensus.getConflicts(block.hash);
    const hasConflicts = conflicts.size > 1;
    const descendantWeight = consensus.getDescendantWeight(block.hash);
    const effectiveWeight = consensus.getEffectiveWeight(block.hash);
    nodeData.push({ hex, block, isCanonical, hasConflicts, descendantWeight, effectiveWeight });
  }

  // Rank by descendant weight for X position
  const sortedByDescWeight = [...nodeData].sort((a, b) => b.descendantWeight - a.descendantWeight);
  const rankMap = new Map<string, number>();
  sortedByDescWeight.forEach((d, i) => rankMap.set(d.hex, i));

  // Layout dimensions
  const graphWidth = Math.max(600, blocks.length * (NODE_WIDTH + 20));
  const graphHeight = Math.max(400, 600);

  // Compute target positions
  const nodes: GraphNode[] = nodeData.map((d) => {
    const rank = rankMap.get(d.hex)!;
    const normalizedX = blocks.length > 1 ? rank / (blocks.length - 1) : 0.5;
    const targetX = PADDING + normalizedX * (graphWidth - 2 * PADDING);

    // Y from log of effective weight (higher weight = higher up)
    const clampedWeight = Math.min(d.effectiveWeight, 1e15);
    const logWeight = Math.log(1 + clampedWeight);
    const maxLog = Math.log(1 + 1e15);
    const normalizedY = maxLog > 0 ? logWeight / maxLog : 0;
    const targetY = graphHeight - PADDING - normalizedY * (graphHeight - 2 * PADDING);

    return {
      id: d.hex,
      block: d.block,
      targetX,
      targetY,
      isCanonical: d.isCanonical,
      hasConflicts: d.hasConflicts,
      descendantWeight: d.descendantWeight,
      effectiveWeight: d.effectiveWeight,
    };
  });

  // Build links
  const links: GraphLink[] = [];
  const nodeSet = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    const anchorHex = node.block.anchor.toHex();
    if (anchorHex !== ZERO_HEX && nodeSet.has(anchorHex)) {
      links.push({ source: node.id, target: anchorHex, type: 'anchor' });
    }
    for (const agg of node.block.aggregates) {
      const aggHex = agg.toHex();
      if (nodeSet.has(aggHex)) {
        links.push({ source: node.id, target: aggHex, type: 'aggregate' });
      }
    }
    for (const ref of node.block.refs) {
      const refHex = ref.toHex();
      if (nodeSet.has(refHex)) {
        links.push({ source: node.id, target: refHex, type: 'ref' });
      }
    }
  }

  return { nodes, links, width: graphWidth, height: graphHeight };
}

function getConnectedHashes(hex: string, blocks: Block[]): string[] {
  const result = new Set<string>();
  result.add(hex);

  const blocksByHex = new Map<string, Block>();
  for (const b of blocks) blocksByHex.set(b.hash.toHex(), b);

  const block = blocksByHex.get(hex);
  if (!block) return [hex];

  // Walk anchor chain up
  let current = block;
  while (true) {
    const anchorHex = current.anchor.toHex();
    if (anchorHex === ZERO_HEX) break;
    result.add(anchorHex);
    const parent = blocksByHex.get(anchorHex);
    if (!parent) break;
    current = parent;
  }

  // Children (blocks that anchor to this one)
  for (const b of blocks) {
    if (b.anchor.toHex() === hex) result.add(b.hash.toHex());
  }

  // Aggregates and refs
  for (const agg of block.aggregates) result.add(agg.toHex());
  for (const ref of block.refs) result.add(ref.toHex());

  return [...result];
}

function getLinkSourceId(link: GraphLink): string {
  return typeof link.source === 'string' ? link.source : (link.source as GraphNode).id;
}

function getLinkTargetId(link: GraphLink): string {
  return typeof link.target === 'string' ? link.target : (link.target as GraphNode).id;
}

function getLinkCoords(link: GraphLink): {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
} {
  const s = link.source as GraphNode;
  const t = link.target as GraphNode;
  return {
    sx: typeof s === 'string' ? 0 : (s.x ?? 0),
    sy: typeof s === 'string' ? 0 : (s.y ?? 0),
    tx: typeof t === 'string' ? 0 : (t.x ?? 0),
    ty: typeof t === 'string' ? 0 : (t.y ?? 0),
  };
}

function edgePath(link: GraphLink): string {
  const { sx, sy, tx, ty } = getLinkCoords(link);
  if (link.type === 'anchor') {
    return `M${sx},${sy}L${tx},${ty}`;
  }
  // Curved path for aggregates and refs
  const dx = tx - sx;
  const dy = ty - sy;
  const offset = link.type === 'aggregate' ? 30 : -30;
  const mx = (sx + tx) / 2 + (-dy / Math.max(Math.sqrt(dx * dx + dy * dy), 1)) * offset;
  const my = (sy + ty) / 2 + (dx / Math.max(Math.sqrt(dx * dx + dy * dy), 1)) * offset;
  return `M${sx},${sy}Q${mx},${my} ${tx},${ty}`;
}

// -- Component --------------------------------------------------------------

interface BlockGraphProps {
  scaffold: Scaffold;
}

export function BlockGraph({ scaffold }: BlockGraphProps) {
  const [blocks, setBlocks] = useState<Block[]>(() => [...scaffold.blocks.getAll()]);
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  const [pinnedHashes, setPinnedHashes] = useState<Set<string>>(new Set());
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [, tick] = useReducer((x: number) => x + 1, 0);

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const rafRef = useRef<number>(0);
  const registry = useHighlightRegistry();

  // Subscribe to new blocks
  useEffect(() => {
    const onAdd = (block: Block) => {
      setBlocks((prev) => [...prev, block]);
    };
    scaffold.blocks.onAdd(onAdd);
    return () => scaffold.blocks.offAdd(onAdd);
  }, [scaffold]);

  // Subscribe to block updates
  useEffect(() => {
    const handlers = new Map<Block, () => void>();
    for (const block of blocks) {
      if (!handlers.has(block)) {
        const handler = () => tick();
        scaffold.blocks.onUpdate(block, handler);
        handlers.set(block, handler);
      }
    }
    return () => {
      for (const [block, handler] of handlers) {
        scaffold.blocks.offUpdate(block, handler);
      }
    };
  }, [scaffold, blocks]);

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Compute graph data
  const graphData = useMemo(
    () => computeGraphData(blocks, scaffold),
    [blocks, scaffold],
  );

  // Update simulation when graph data changes
  useEffect(() => {
    const { nodes: newNodes, links: newLinks } = graphData;

    // Preserve positions for existing nodes
    const oldPosMap = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    for (const n of nodesRef.current) {
      oldPosMap.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, vx: n.vx ?? 0, vy: n.vy ?? 0 });
    }

    for (const n of newNodes) {
      const old = oldPosMap.get(n.id);
      if (old) {
        n.x = old.x;
        n.y = old.y;
        n.vx = old.vx;
        n.vy = old.vy;
      } else {
        // New node: start near its target with jitter
        n.x = n.targetX + (Math.random() - 0.5) * 40;
        n.y = n.targetY + (Math.random() - 0.5) * 40;
      }
    }

    nodesRef.current = newNodes;
    linksRef.current = newLinks;

    // Stop old simulation
    if (simRef.current) simRef.current.stop();

    const sim = forceSimulation<GraphNode>(newNodes)
      .force('x', forceX<GraphNode>((d) => d.targetX).strength(0.15))
      .force('y', forceY<GraphNode>((d) => d.targetY).strength(0.15))
      .force('collide', forceCollide<GraphNode>(NODE_WIDTH / 2 + 4).strength(0.7))
      .force(
        'link',
        forceLink<GraphNode, GraphLink>(newLinks)
          .id((d) => d.id)
          .distance(NODE_WIDTH * 1.5)
          .strength(0.3),
      )
      .alphaDecay(0.02)
      .alpha(oldPosMap.size > 0 ? 0.5 : 1)
      .on('tick', () => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          tick();
        });
      });

    simRef.current = sim;

    return () => {
      sim.stop();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [graphData]);

  // Setup zoom
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        tick();
      });

    select(svg).call(zoomBehavior);
    zoomRef.current = zoomBehavior;

    return () => {
      select(svg).on('.zoom', null);
    };
  }, []);

  // Hover handler
  const handleNodeHover = useCallback(
    (hex: string | null) => {
      if (hex) {
        const connected = getConnectedHashes(hex, blocks);
        registry.setHovered(connected);
      } else {
        registry.setHovered([]);
      }
    },
    [blocks, registry],
  );

  const handleFocus = useCallback((hex: string) => {
    setFocusedHash((prev) => (prev === hex ? null : hex));
  }, []);

  const togglePin = useCallback((hex: string) => {
    setPinnedHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hex)) next.delete(hex);
      else next.add(hex);
      return next;
    });
  }, []);

  const handleNavigate = useCallback(
    (hex: string) => {
      const exists = blocks.some((b) => b.hash.toHex() === hex);
      if (exists) setFocusedHash(hex);
    },
    [blocks],
  );

  const handleCloseDetail = useCallback(() => setFocusedHash(null), []);

  // Render
  const t = transformRef.current;
  const nodes = nodesRef.current;
  const links = linksRef.current;

  // Determine highlighted set for edges
  const hoveredSet = new Set<string>();
  // We use the registry's current set indirectly through node highlighting

  const focusedBlock = focusedHash
    ? blocks.find((b) => b.hash.toHex() === focusedHash)
    : null;

  return (
    <div className="block-graph-container" ref={containerRef}>
      {/* Pin bar */}
      {pinnedHashes.size > 0 && (
        <div className="pin-bar">
          {[...pinnedHashes].map((hex) => (
            <span key={hex} className="pin-chip" onClick={() => handleFocus(hex)}>
              <span className="pin-chip-hash">{hex.slice(0, 8)}…</span>
              <button
                className="pin-chip-close"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(hex);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* SVG canvas */}
      <svg
        ref={svgRef}
        className="block-graph-svg"
        width={dimensions.width}
        height={dimensions.height}
      >
        <defs>
          <marker
            id="arrow-anchor"
            viewBox="0 0 10 8"
            refX="10"
            refY="4"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,4 L0,8 Z" fill="#1d1d1f" />
          </marker>
          <marker
            id="arrow-aggregate"
            viewBox="0 0 10 8"
            refX="10"
            refY="4"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,4 L0,8 Z" fill="#0071e3" />
          </marker>
          <marker
            id="arrow-ref"
            viewBox="0 0 10 8"
            refX="10"
            refY="4"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,4 L0,8 Z" fill="#8e8e93" />
          </marker>
        </defs>

        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {/* Edges layer */}
          <g className="edges">
            {links.map((link, i) => {
              const sourceId = getLinkSourceId(link);
              const targetId = getLinkTargetId(link);
              const key = `${sourceId}-${targetId}-${link.type}`;
              return (
                <path
                  key={key}
                  className={`graph-edge graph-edge-${link.type}`}
                  d={edgePath(link)}
                  markerEnd={`url(#arrow-${link.type})`}
                />
              );
            })}
          </g>

          {/* Nodes layer */}
          <g className="nodes">
            {nodes.map((node) => {
              const nx = node.x ?? 0;
              const ny = node.y ?? 0;
              const isFocused = focusedHash === node.id;
              const isPinned = pinnedHashes.has(node.id);

              let statusClass = node.isCanonical ? 'canonical' : 'non-canonical';
              if (node.hasConflicts) statusClass = 'conflict';

              const classList = ['graph-node', `graph-node-${statusClass}`];
              if (isFocused) classList.push('focused');
              if (isPinned) classList.push('pinned');

              const statusLabel = node.hasConflicts
                ? 'CONFLICT'
                : node.isCanonical
                  ? 'CANONICAL'
                  : 'NON-CANON';

              return (
                <g
                  key={node.id}
                  className={classList.join(' ')}
                  transform={`translate(${nx - NODE_WIDTH / 2},${ny - NODE_HEIGHT / 2})`}
                  onMouseEnter={() => handleNodeHover(node.id)}
                  onMouseLeave={() => handleNodeHover(null)}
                  onClick={() => handleFocus(node.id)}
                >
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={8}
                    ry={8}
                  />
                  <text
                    className="graph-node-hash"
                    x={NODE_WIDTH / 2}
                    y={18}
                    textAnchor="middle"
                  >
                    {node.id.slice(0, 10)}…
                  </text>
                  <text
                    className="graph-node-status"
                    x={NODE_WIDTH / 2}
                    y={32}
                    textAnchor="middle"
                  >
                    {statusLabel}
                  </text>
                  <text
                    className="graph-node-weight"
                    x={NODE_WIDTH / 2}
                    y={46}
                    textAnchor="middle"
                  >
                    w:{node.block.declaredWeight} d:{node.descendantWeight}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* Detail panel */}
      {focusedHash && focusedBlock && (
        <BlockGraphDetail
          hash={focusedHash}
          scaffold={scaffold}
          pinned={pinnedHashes.has(focusedHash)}
          onClose={handleCloseDetail}
          onPin={() => togglePin(focusedHash)}
          onNavigate={handleNavigate}
        />
      )}

      {/* Footer */}
      <div className="graph-footer">
        {blocks.length} block{blocks.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
