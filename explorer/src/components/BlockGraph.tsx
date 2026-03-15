import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { useHighlightRegistry } from '../highlight/HighlightContext.ts';
import { getContractName } from '../contracts.ts';
import { DateSummary } from './DateSummary.tsx';
import { Hash } from 'scaffold.io/util/Hash.ts';
import { SIGNATURE_CONTRACT } from 'scaffold.io/core/Block.ts';
import type { Block } from 'scaffold.io/core/Block.ts';
import type { Output } from 'scaffold.io/core/BlockCreationModule.ts';
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

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

// -- Constants --------------------------------------------------------------

const NODE_WIDTH = 140;
const NODE_HEIGHT = 56;
const FOCUSED_WIDTH = 380;
const FOCUSED_MAX_HEIGHT = 500;
const PADDING = 60;
const MAX_IO_DISPLAY = 5;
const VIEWBOX_LERP = 0.12;
const VIEWBOX_THRESHOLD = 0.5;

const ZERO_HEX = '0'.repeat(64);

// -- Helpers ----------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function computeGraphData(
  blocks: Block[],
  scaffold: Scaffold,
): { nodes: GraphNode[]; links: GraphLink[]; width: number; height: number } {
  const ctx = scaffold.context;
  const consensus = ctx.consensus;

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

  const sortedByDescWeight = [...nodeData].sort((a, b) => b.descendantWeight - a.descendantWeight);
  const rankMap = new Map<string, number>();
  sortedByDescWeight.forEach((d, i) => rankMap.set(d.hex, i));

  const graphWidth = Math.max(600, blocks.length * (NODE_WIDTH + 20));
  const graphHeight = Math.max(400, 600);

  const nodes: GraphNode[] = nodeData.map((d) => {
    const rank = rankMap.get(d.hex)!;
    const normalizedX = blocks.length > 1 ? rank / (blocks.length - 1) : 0.5;
    const targetX = PADDING + normalizedX * (graphWidth - 2 * PADDING);

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

  let current = block;
  while (true) {
    const anchorHex = current.anchor.toHex();
    if (anchorHex === ZERO_HEX) break;
    result.add(anchorHex);
    const parent = blocksByHex.get(anchorHex);
    if (!parent) break;
    current = parent;
  }

  for (const b of blocks) {
    if (b.anchor.toHex() === hex) result.add(b.hash.toHex());
  }

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
  const dx = tx - sx;
  const dy = ty - sy;
  const offset = link.type === 'aggregate' ? 30 : -30;
  const mx = (sx + tx) / 2 + (-dy / Math.max(Math.sqrt(dx * dx + dy * dy), 1)) * offset;
  const my = (sy + ty) / 2 + (dx / Math.max(Math.sqrt(dx * dx + dy * dy), 1)) * offset;
  return `M${sx},${sy}Q${mx},${my} ${tx},${ty}`;
}

function getAuthorHex(block: Block): string | null {
  for (const out of block.outputs) {
    if (Hash.equals(out.verifier.contract, SIGNATURE_CONTRACT)) {
      return toHex(out.verifier.params);
    }
  }
  return null;
}

function resolveOutput(block: Block, claimIndex: number, anchorBlock?: Block): Output | undefined {
  if (claimIndex < block.outputs.length) return block.outputs[claimIndex];
  const anchorIdx = claimIndex - block.outputs.length;
  return anchorBlock?.outputs[anchorIdx];
}

/** Compute the target viewBox that fits the interesting nodes. */
function computeFitViewBox(
  nodes: GraphNode[],
  focusedHash: string | null,
  pinnedHashes: Set<string>,
  aspectRatio: number,
): ViewBox {
  if (nodes.length === 0) return { x: 0, y: 0, w: 800, h: 600 };

  // Which nodes to fit: focused + pinned, or all
  const interesting = new Set<string>();
  if (focusedHash) interesting.add(focusedHash);
  for (const hex of pinnedHashes) interesting.add(hex);

  let fitNodes = interesting.size > 0
    ? nodes.filter((n) => interesting.has(n.id))
    : nodes;
  if (fitNodes.length === 0) fitNodes = nodes;

  // Bounding box of fit nodes
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of fitNodes) {
    const nx = node.x ?? node.targetX;
    const ny = node.y ?? node.targetY;
    const isFocused = focusedHash === node.id;
    const halfW = isFocused ? FOCUSED_WIDTH / 2 : NODE_WIDTH / 2;
    const halfH = isFocused ? FOCUSED_MAX_HEIGHT / 2 : NODE_HEIGHT / 2;
    minX = Math.min(minX, nx - halfW);
    minY = Math.min(minY, ny - halfH);
    maxX = Math.max(maxX, nx + halfW);
    maxY = Math.max(maxY, ny + halfH);
  }

  const pad = 60;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  let w = Math.max(maxX - minX, 200);
  let h = Math.max(maxY - minY, 200);

  // Match aspect ratio to SVG viewport to avoid letterboxing
  if (aspectRatio > 0) {
    const contentAR = w / h;
    if (contentAR > aspectRatio) {
      const newH = w / aspectRatio;
      minY -= (newH - h) / 2;
      h = newH;
    } else {
      const newW = h * aspectRatio;
      minX -= (newW - w) / 2;
      w = newW;
    }
  }

  return { x: minX, y: minY, w, h };
}

function lerpViewBox(current: ViewBox, target: ViewBox, t: number): ViewBox {
  return {
    x: current.x + (target.x - current.x) * t,
    y: current.y + (target.y - current.y) * t,
    w: current.w + (target.w - current.w) * t,
    h: current.h + (target.h - current.h) * t,
  };
}

function viewBoxConverged(a: ViewBox, b: ViewBox): boolean {
  return Math.abs(a.x - b.x) < VIEWBOX_THRESHOLD &&
    Math.abs(a.y - b.y) < VIEWBOX_THRESHOLD &&
    Math.abs(a.w - b.w) < VIEWBOX_THRESHOLD &&
    Math.abs(a.h - b.h) < VIEWBOX_THRESHOLD;
}

// -- Sub-components ---------------------------------------------------------

function HashChip(
  { hex, registry, onNavigate }: {
    hex: string;
    registry: ReturnType<typeof useHighlightRegistry>;
    onNavigate: (hex: string) => void;
  },
) {
  return (
    <span
      className="expanded-hash-chip"
      onMouseEnter={() => registry.setHovered([hex])}
      onMouseLeave={() => registry.setHovered([])}
      onClick={(e) => {
        e.stopPropagation();
        onNavigate(hex);
      }}
    >
      {hex.slice(0, 10)}…
    </span>
  );
}

function IOChip(
  { output, label, onClick }: {
    output: Output;
    label: string;
    onClick: () => void;
  },
) {
  const contractName = getContractName(output.verifier.contract);
  return (
    <div className="io-chip" onClick={onClick} title={label}>
      <span className="io-chip-value">v={output.value}</span>
      <span className="io-chip-contract">
        {contractName ?? output.verifier.contract.toHex().slice(0, 8) + '…'}
      </span>
      {output.verifier.params.length > 0 && (
        <span className="io-chip-params">{toHex(output.verifier.params).slice(0, 8)}…</span>
      )}
    </div>
  );
}

// -- Overlay ----------------------------------------------------------------

interface OverlayData {
  type: 'claim' | 'output';
  index: number;
  output: Output;
}

function IOOverlay(
  { data, onClose }: { data: OverlayData; onClose: () => void },
) {
  const contractName = getContractName(data.output.verifier.contract);
  return (
    <div className="io-overlay-backdrop" onClick={onClose}>
      <div className="io-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="io-overlay-header">
          <span>{data.type === 'claim' ? 'Claim' : 'Output'} #{data.index}</span>
          <button className="graph-detail-close" onClick={onClose}>×</button>
        </div>
        <div className="io-overlay-row">
          <span className="detail-label">Value</span>
          <span className="detail-value mono">{data.output.value}</span>
        </div>
        <div className="io-overlay-row">
          <span className="detail-label">Contract</span>
          <span className="detail-value mono">
            {contractName ?? data.output.verifier.contract.toHex()}
          </span>
        </div>
        <div className="io-overlay-row">
          <span className="detail-label">Params</span>
          <span className="detail-value mono" style={{ wordBreak: 'break-all' }}>
            {data.output.verifier.params.length > 0
              ? toHex(data.output.verifier.params)
              : <span className="muted">empty</span>}
          </span>
        </div>
        <div className="io-overlay-row">
          <span className="detail-label">Detail</span>
          <span className="detail-value mono" style={{ wordBreak: 'break-all' }}>
            {data.output.detail.length > 0
              ? toHex(data.output.detail)
              : <span className="muted">empty</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

// -- Component --------------------------------------------------------------

interface BlockGraphProps {
  scaffold: Scaffold;
}

export function BlockGraph({ scaffold }: BlockGraphProps) {
  const [blocks, setBlocks] = useState<Block[]>(() => [...scaffold.blocks.getAll()]);
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  const [pinnedHashes, setPinnedHashes] = useState<Set<string>>(new Set());
  const [svgSize, setSvgSize] = useState({ width: 800, height: 500 });
  const [overlayData, setOverlayData] = useState<OverlayData | null>(null);
  const [, tick] = useReducer((x: number) => x + 1, 0);

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<GraphLink[]>([]);
  const viewBoxRef = useRef<ViewBox>({ x: 0, y: 0, w: 800, h: 600 });
  const viewBoxInitRef = useRef(false);
  const rafRef = useRef<number>(0);
  const viewBoxRafRef = useRef<number>(0);
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

  // Observe SVG rendered size (for aspect ratio, no feedback into attributes)
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.round(entry.contentRect.width);
        const h = Math.round(entry.contentRect.height);
        if (w > 0 && h > 0) {
          setSvgSize((prev) => {
            if (prev.width === w && prev.height === h) return prev;
            return { width: w, height: h };
          });
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
        n.x = n.targetX + (Math.random() - 0.5) * 40;
        n.y = n.targetY + (Math.random() - 0.5) * 40;
      }
    }

    nodesRef.current = newNodes;
    linksRef.current = newLinks;

    // Snap viewBox on first data
    if (!viewBoxInitRef.current && newNodes.length > 0) {
      viewBoxInitRef.current = true;
      const ar = svgSize.width / Math.max(svgSize.height, 1);
      viewBoxRef.current = computeFitViewBox(newNodes, null, new Set(), ar);
    }

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

  // Update collide force when focused node changes
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.force(
      'collide',
      forceCollide<GraphNode>((d) => {
        if (focusedHash && d.id === focusedHash) return FOCUSED_WIDTH / 2 + 10;
        return NODE_WIDTH / 2 + 4;
      }).strength(0.7),
    );
    sim.alpha(0.3).restart();
  }, [focusedHash]);

  // Animate viewBox -- runs after every render, lerps toward target
  useEffect(() => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;

    const ar = svgSize.width / Math.max(svgSize.height, 1);
    const target = computeFitViewBox(nodes, focusedHash, pinnedHashes, ar);
    const next = lerpViewBox(viewBoxRef.current, target, VIEWBOX_LERP);
    viewBoxRef.current = next;

    const svg = svgRef.current;
    if (svg) {
      svg.setAttribute('viewBox', `${next.x} ${next.y} ${next.w} ${next.h}`);
    }

    // If not converged, schedule another frame to continue animation
    if (!viewBoxConverged(next, target)) {
      if (viewBoxRafRef.current) cancelAnimationFrame(viewBoxRafRef.current);
      viewBoxRafRef.current = requestAnimationFrame(() => {
        viewBoxRafRef.current = 0;
        tick();
      });
    }

    return () => {
      if (viewBoxRafRef.current) {
        cancelAnimationFrame(viewBoxRafRef.current);
        viewBoxRafRef.current = 0;
      }
    };
  });

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

  const handleNodeClick = useCallback((hex: string) => {
    setFocusedHash((prev) => {
      if (prev === hex) {
        // Already focused -- toggle pin
        setPinnedHashes((p) => {
          const next = new Set(p);
          if (next.has(hex)) next.delete(hex);
          else next.add(hex);
          return next;
        });
        return prev;
      }
      return hex;
    });
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

  // Render
  const nodes = nodesRef.current;
  const links = linksRef.current;
  const ctx = scaffold.context;
  const consensus = ctx.consensus;

  // Sort nodes: focused last so it renders on top
  const sortedNodes = useMemo(() => {
    if (!focusedHash) return nodes;
    const copy = [...nodes];
    copy.sort((a, b) => {
      if (a.id === focusedHash) return 1;
      if (b.id === focusedHash) return -1;
      return 0;
    });
    return copy;
  }, [nodes, focusedHash]);

  // Find the focused block and its anchor block
  const focusedBlock = focusedHash
    ? blocks.find((b) => b.hash.toHex() === focusedHash)
    : null;
  const anchorBlock = focusedBlock && focusedBlock.anchor.toHex() !== ZERO_HEX
    ? ctx.store.get(focusedBlock.anchor)
    : undefined;

  // Aggregating blocks: blocks whose aggregates[] includes the focused block
  const aggregatingBlocks = useMemo(() => {
    if (!focusedBlock) return [];
    return blocks
      .filter((b) => b.aggregates.some((a) => Hash.equals(a, focusedBlock.hash)))
      .sort((a, b) => {
        const aCan = consensus.isCanonical(a.hash) ? 0 : 1;
        const bCan = consensus.isCanonical(b.hash) ? 0 : 1;
        return aCan - bCan;
      });
  }, [focusedBlock, blocks, consensus]);

  return (
    <div className="block-graph-container" ref={containerRef}>
      {/* Pin bar */}
      {pinnedHashes.size > 0 && (
        <div className="pin-bar">
          {[...pinnedHashes].map((hex) => (
            <span key={hex} className="pin-chip" onClick={() => handleNodeClick(hex)}>
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
        preserveAspectRatio="xMidYMid meet"
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

        <g>
          {/* Edges layer */}
          <g className="edges">
            {links.map((link) => {
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
            {sortedNodes.map((node) => {
              const nx = node.x ?? 0;
              const ny = node.y ?? 0;
              const isFocused = focusedHash === node.id;
              const isPinned = pinnedHashes.has(node.id);

              let statusClass = node.isCanonical ? 'canonical' : 'non-canonical';
              if (node.hasConflicts) statusClass = 'conflict';

              const classList = ['graph-node', `graph-node-${statusClass}`];
              if (isFocused) classList.push('focused');
              if (isPinned) classList.push('pinned');

              if (isFocused && focusedBlock) {
                // -- Expanded inline node --
                const authorHex = getAuthorHex(focusedBlock);
                const isGenesis = focusedBlock.anchor.toHex() === ZERO_HEX;

                // All claims resolved to their outputs
                const allClaims = focusedBlock.claims
                  .map((ci) => ({
                    index: ci,
                    output: resolveOutput(focusedBlock, ci, anchorBlock),
                  }))
                  .filter((c): c is { index: number; output: Output } => !!c.output);

                return (
                  <g
                    key={node.id}
                    className={classList.join(' ')}
                    transform={`translate(${nx - FOCUSED_WIDTH / 2},${ny - FOCUSED_MAX_HEIGHT / 2})`}
                    onMouseEnter={() => handleNodeHover(node.id)}
                    onMouseLeave={() => handleNodeHover(null)}
                  >
                    <foreignObject
                      width={FOCUSED_WIDTH}
                      height={FOCUSED_MAX_HEIGHT}
                      style={{ pointerEvents: 'none', overflow: 'hidden' }}
                    >
                      <div style={{
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        pointerEvents: 'none',
                      }}>
                      <div
                        className={`block-expanded${isPinned ? ' pinned' : ''}`}
                        style={{ pointerEvents: 'auto' }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => handleNodeClick(node.id)}
                      >
                        {/* Header */}
                        <div className="block-expanded-header">
                          <span className="block-expanded-hash">{node.id.slice(0, 12)}…</span>
                          {authorHex && (
                            <span className="block-expanded-author">
                              {authorHex.slice(0, 8)}…
                            </span>
                          )}
                          <span className="block-expanded-time">
                            <DateSummary instantMs={focusedBlock.timestamp} />
                          </span>
                        </div>

                        {/* Weights */}
                        <div className="block-expanded-weights">
                          <span>Self: {focusedBlock.declaredWeight}</span>
                          <span>Subtree: {node.effectiveWeight}</span>
                          <span>Desc: {node.descendantWeight}</span>
                        </div>

                        {/* Aggregating blocks */}
                        {aggregatingBlocks.length > 0 && (
                          <div className="block-expanded-section">
                            <div className="block-expanded-section-label">
                              Aggregated by ({aggregatingBlocks.length})
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {aggregatingBlocks.map((b) => (
                                <HashChip
                                  key={b.hash.toHex()}
                                  hex={b.hash.toHex()}
                                  registry={registry}
                                  onNavigate={handleNavigate}
                                />
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Anchor + anchor claims */}
                        {!isGenesis && (
                          <div className="block-expanded-section">
                            <div className="block-expanded-anchor">
                              <div>
                                <div className="block-expanded-section-label">Anchor</div>
                                <HashChip
                                  hex={focusedBlock.anchor.toHex()}
                                  registry={registry}
                                  onNavigate={handleNavigate}
                                />
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Claims + Outputs */}
                        {(allClaims.length > 0 || focusedBlock.outputs.length > 0) && (
                          <div className="block-expanded-section">
                            <div className="block-expanded-io">
                              <div>
                                <div className="block-expanded-section-label">
                                  Claims ({allClaims.length})
                                </div>
                                {allClaims.slice(0, MAX_IO_DISPLAY).map((c) => (
                                  <IOChip
                                    key={c.index}
                                    output={c.output}
                                    label={`Claim #${c.index}`}
                                    onClick={() =>
                                      setOverlayData({
                                        type: 'claim',
                                        index: c.index,
                                        output: c.output,
                                      })}
                                  />
                                ))}
                                {allClaims.length > MAX_IO_DISPLAY && (
                                  <span className="io-more">
                                    +{allClaims.length - MAX_IO_DISPLAY} more
                                  </span>
                                )}
                              </div>
                              <div>
                                <div className="block-expanded-section-label">
                                  Outputs ({focusedBlock.outputs.length})
                                </div>
                                {focusedBlock.outputs.slice(0, MAX_IO_DISPLAY).map((out, i) => (
                                  <IOChip
                                    key={i}
                                    output={out}
                                    label={`Output #${i}`}
                                    onClick={() =>
                                      setOverlayData({ type: 'output', index: i, output: out })}
                                  />
                                ))}
                                {focusedBlock.outputs.length > MAX_IO_DISPLAY && (
                                  <span className="io-more">
                                    +{focusedBlock.outputs.length - MAX_IO_DISPLAY} more
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Aggregated blocks */}
                        {focusedBlock.aggregates.length > 0 && (
                          <div className="block-expanded-section">
                            <div className="block-expanded-section-label">
                              Aggregates ({focusedBlock.aggregates.length})
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {focusedBlock.aggregates.map((h) => (
                                <HashChip
                                  key={h.toHex()}
                                  hex={h.toHex()}
                                  registry={registry}
                                  onNavigate={handleNavigate}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      </div>
                    </foreignObject>
                  </g>
                );
              }

              // -- Compact node --
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
                  onClick={() => handleNodeClick(node.id)}
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

      {/* IO Overlay */}
      {overlayData && <IOOverlay data={overlayData} onClose={() => setOverlayData(null)} />}

      {/* Footer */}
      <div className="graph-footer">
        {blocks.length} block{blocks.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
