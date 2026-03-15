import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { BlockRow } from './BlockRow.tsx';
import { FilterBar, FilterState } from './FilterBar.tsx';
import type { Block } from 'scaffold.io/core/Block.ts';
import type { Scaffold } from 'scaffold.io/Scaffold.ts';

const ALL_COLUMNS = [
  { key: 'hash', label: 'Hash' },
  { key: 'canonicality', label: 'Canonicality' },
  { key: 'source', label: 'Source' },
  { key: 'timestamp', label: 'Timestamp' },
  { key: 'receivedAt', label: 'Received' },
  { key: 'declaredWeight', label: 'Declared Wt' },
  { key: 'descendantWeight', label: 'Desc. Weight' },
  { key: 'outputs', label: 'Outputs' },
  { key: 'inputs', label: 'Claims' },
  { key: 'aggregates', label: 'Aggregates' },
  { key: 'throughput', label: 'Throughput' },
  { key: 'validity', label: 'Validity' },
  { key: 'trust', label: 'Collateral' },
];

const DEFAULT_COLUMNS = new Set([
  'hash',
  'canonicality',
  'declaredWeight',
  'descendantWeight',
  'outputs',
  'inputs',
  'aggregates',
]);

type SortKey = string;
type SortDir = 'asc' | 'desc';

export function BlockTable({ scaffold }: { scaffold: Scaffold }) {
  const [blocks, setBlocks] = useState<Block[]>(() => [...scaffold.blocks.getAll()]);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [pinnedHashes, setPinnedHashes] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('receivedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [columns, setColumns] = useState<Set<string>>(DEFAULT_COLUMNS);
  const [filter, setFilter] = useState<FilterState>({
    search: '',
    showCanonical: true,
    showNonCanonical: true,
    sourceFilter: '',
  });
  // Increments when any block's dynamic state changes, triggering sort refresh
  const [sortTrigger, bumpSort] = useReducer((x: number) => x + 1, 0);

  // Subscribe to new blocks
  useEffect(() => {
    const onAdd = (block: Block) => {
      setBlocks((prev) => [...prev, block]);
    };
    scaffold.blocks.onAdd(onAdd);
    return () => scaffold.blocks.offAdd(onAdd);
  }, [scaffold]);

  // Subscribe to all block updates for sort refresh
  useEffect(() => {
    const handlers = new Map<Block, () => void>();
    for (const block of blocks) {
      if (!handlers.has(block)) {
        const handler = () => bumpSort();
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

  const toggleExpand = useCallback((hash: string) => {
    setExpandedHash((prev) => prev === hash ? null : hash);
  }, []);

  const togglePin = useCallback((hash: string) => {
    setPinnedHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }, []);

  const handleSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
        return prev;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  // Filter + sort
  const displayed = useMemo(() => {
    const ctx = scaffold.context;

    // Filter
    let filtered = blocks.filter((block) => {
      const isCanonical = ctx.consensus.isCanonical(block.hash);
      if (isCanonical && !filter.showCanonical) return false;
      if (!isCanonical && !filter.showNonCanonical) return false;
      if (filter.sourceFilter && block.source !== filter.sourceFilter) return false;
      if (filter.search) {
        const hex = block.hash.toHex();
        if (!hex.includes(filter.search.toLowerCase())) return false;
      }
      return true;
    });

    // Sort
    const getSortValue = (block: Block): number | string => {
      switch (sortKey) {
        case 'hash':
          return block.hash.toHex();
        case 'canonicality':
          return ctx.consensus.isCanonical(block.hash) ? 1 : 0;
        case 'source':
          return block.source;
        case 'timestamp':
          return block.timestamp;
        case 'receivedAt':
          return block.receivedAt;
        case 'declaredWeight':
          return block.declaredWeight;
        case 'descendantWeight':
          return ctx.consensus.getDescendantWeight(block.hash);
        case 'outputs':
          return block.outputs.length;
        case 'inputs':
          return block.claims.length;
        case 'aggregates':
          return block.aggregates.length;
        case 'throughput':
          return block.outputs.reduce((s, o) => s + o.value, 0);
        default:
          return 0;
      }
    };

    filtered.sort((a, b) => {
      const va = getSortValue(a);
      const vb = getSortValue(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });

    // Pinned blocks at top
    const pinned = filtered.filter((b) => pinnedHashes.has(b.hash.toHex()));
    const unpinned = filtered.filter((b) => !pinnedHashes.has(b.hash.toHex()));

    return [...pinned, ...unpinned];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, filter, sortKey, sortDir, pinnedHashes, scaffold, sortTrigger]);

  const sortIndicator = (key: string) => {
    if (sortKey !== key) return null;
    return sortDir === 'asc' ? ' \u2191' : ' \u2193';
  };

  return (
    <div className='block-table-container'>
      <FilterBar
        filter={filter}
        onChange={setFilter}
        columns={columns}
        onColumnsChange={setColumns}
        allColumns={ALL_COLUMNS}
      />

      <div className='block-table'>
        <div className='block-row header-row'>
          <div className='cell cell-pin' />
          {columns.has('hash') && (
            <div
              className='cell cell-hash clickable'
              onClick={() => handleSort('hash')}
            >
              Hash{sortIndicator('hash')}
            </div>
          )}
          {columns.has('canonicality') && (
            <div
              className='cell cell-canonical clickable'
              onClick={() => handleSort('canonicality')}
            >
              Status{sortIndicator('canonicality')}
            </div>
          )}
          {columns.has('source') && (
            <div
              className='cell cell-source clickable'
              onClick={() => handleSort('source')}
            >
              Source{sortIndicator('source')}
            </div>
          )}
          {columns.has('timestamp') && (
            <div
              className='cell cell-time clickable'
              onClick={() => handleSort('timestamp')}
            >
              Created{sortIndicator('timestamp')}
            </div>
          )}
          {columns.has('receivedAt') && (
            <div
              className='cell cell-time clickable'
              onClick={() => handleSort('receivedAt')}
            >
              Received{sortIndicator('receivedAt')}
            </div>
          )}
          {columns.has('declaredWeight') && (
            <div
              className='cell cell-num clickable'
              onClick={() => handleSort('declaredWeight')}
            >
              Weight{sortIndicator('declaredWeight')}
            </div>
          )}
          {columns.has('descendantWeight') && (
            <div
              className='cell cell-num clickable'
              onClick={() => handleSort('descendantWeight')}
            >
              Desc. Wt{sortIndicator('descendantWeight')}
            </div>
          )}
          {columns.has('outputs') && (
            <div
              className='cell cell-num clickable'
              onClick={() => handleSort('outputs')}
            >
              Outs{sortIndicator('outputs')}
            </div>
          )}
          {columns.has('inputs') && (
            <div
              className='cell cell-num clickable'
              onClick={() => handleSort('inputs')}
            >
              Claims{sortIndicator('inputs')}
            </div>
          )}
          {columns.has('aggregates') && (
            <div
              className='cell cell-num clickable'
              onClick={() => handleSort('aggregates')}
            >
              Aggs{sortIndicator('aggregates')}
            </div>
          )}
          {columns.has('throughput') && (
            <div
              className='cell cell-num clickable'
              onClick={() => handleSort('throughput')}
            >
              Thru{sortIndicator('throughput')}
            </div>
          )}
          {columns.has('validity') && (
            <div
              className='cell cell-validity clickable'
              onClick={() => handleSort('validity')}
            >
              Validity{sortIndicator('validity')}
            </div>
          )}
          {columns.has('trust') && (
            <div
              className='cell cell-trust clickable'
              onClick={() => handleSort('trust')}
            >
              Collateral{sortIndicator('trust')}
            </div>
          )}
        </div>

        {displayed.map((block) => {
          const hex = block.hash.toHex();
          return (
            <BlockRow
              key={hex}
              scaffold={scaffold}
              block={block}
              recordSet={scaffold.blocks}
              expanded={expandedHash === hex}
              pinned={pinnedHashes.has(hex)}
              onToggle={() => toggleExpand(hex)}
              onPin={() => togglePin(hex)}
              columns={columns}
            />
          );
        })}

        {displayed.length === 0 && (
          <div className='block-row empty-row'>
            <div className='cell' style={{ gridColumn: '1 / -1', textAlign: 'center' }}>
              No blocks match current filters
            </div>
          </div>
        )}
      </div>

      <div className='table-footer'>
        {blocks.length} block{blocks.length !== 1 ? 's' : ''} total, {displayed.length} shown
      </div>
    </div>
  );
}
