/**
 * Ghost node computation.
 *
 * After filtering, blocks directly connected to a visible block that were
 * not themselves matched appear as dimmed "ghost" nodes. This preserves
 * navigability -- users can click ghost nodes to walk the graph.
 */

// -- Types ------------------------------------------------------------------

/** Minimal block structure needed for neighbor computation. */
export interface BlockEdges {
  hash: string;
  anchor: string;
  aggregates: string[];
  refs: string[];
}

// -- Ghost computation ------------------------------------------------------

/** Hex string for the zero hash (genesis anchor). */
const ZERO_HEX = "0".repeat(64);

/**
 * Compute the set of ghost block hashes.
 *
 * A ghost block is one that:
 * 1. Is NOT in `visibleHashes` (not matched, not pinned, not focused)
 * 2. IS directly connected (anchor, aggregate, or ref edge in either
 *    direction) to at least one block in `visibleHashes`
 * 3. EXISTS in `allBlocks`
 *
 * Returns the set of ghost block hex hashes.
 */
export function computeGhostHashes(
  visibleHashes: Set<string>,
  allBlocks: BlockEdges[],
): Set<string> {
  const allHashSet = new Set<string>();
  const byHash = new Map<string, BlockEdges>();
  for (const block of allBlocks) {
    allHashSet.add(block.hash);
    byHash.set(block.hash, block);
  }

  // Build reverse adjacency: for each hash, which blocks reference it
  const reverseNeighbors = new Map<string, string[]>();
  for (const block of allBlocks) {
    const targets = [block.anchor, ...block.aggregates, ...block.refs];
    for (const target of targets) {
      if (!reverseNeighbors.has(target)) reverseNeighbors.set(target, []);
      reverseNeighbors.get(target)!.push(block.hash);
    }
  }

  const ghosts = new Set<string>();

  for (const hash of visibleHashes) {
    const block = byHash.get(hash);
    if (!block) continue;

    // Forward neighbors: anchor, aggregates, refs
    const forward = [block.anchor, ...block.aggregates, ...block.refs];
    // Reverse neighbors: blocks whose anchor/aggregates/refs point to this block
    const reverse = reverseNeighbors.get(hash) ?? [];

    for (const neighbor of [...forward, ...reverse]) {
      if (
        neighbor !== ZERO_HEX &&
        allHashSet.has(neighbor) &&
        !visibleHashes.has(neighbor)
      ) {
        ghosts.add(neighbor);
      }
    }
  }

  return ghosts;
}
