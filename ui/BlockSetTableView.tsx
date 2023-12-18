import React from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  Row,
  SortingState,
  useReactTable,
} from 'tanstack-table';
import { useVirtual } from 'tanstack-virtual';
import Context from '../sbl/Context.ts';
import Logger from '../sbl/Logger.ts';
import { bin2hex } from '../sbl/util/hex.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import Hash, { HashPrimitive } from '../sbl/util/Hash.ts';
import { trunc } from '../sbl/util/string.ts';
import { BlockInput, BlockOutput } from '../sbl/messages.ts';
import { BlockSetFact, Collateralization, FactSource } from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import BlockService from '~/sbl/BlockService.ts';
import HashView from '~/ui/HashView.tsx';
import CollateralUtil from '~/sbl/CollateralUtil.ts';

const RowDetail = ({ name, val }: { name: string; val: string }) => (
  <div>
    {name}: <pre style={{ display: 'inline' }}>{val}</pre>
  </div>
);

const getBlocks = (ctx: Context) =>
  ctx.get(FactService).hackyGetBlockSetsMatching();

export default (
  { ctx, selectedHash, setSelectedHash, hoveredHash, setHoveredHash }: {
    ctx: Context;
    selectedHash?: HashPrimitive;
    setSelectedHash(primitive?: HashPrimitive): void;
    hoveredHash?: HashPrimitive;
    setHoveredHash(primitive?: HashPrimitive): void;
  },
) => {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const columns = React.useMemo<ColumnDef<BlockSetFact>[]>(
    () => [
      {
        header: 'hash',
        accessorFn: (blockSet) => blockSet.hash.toHex(),
        cell: (props) => (
          <a
            href='#'
            onClick={() => {
              !props.row.getIsExpanded() &&
                setSelectedHash(props.row.original.hash.toPrimitive());
              props.row.toggleExpanded();
            }}
          >
            <span style={{ fontFamily: 'monospace' }}>
              {props.getValue<string>().slice(0, 10)}
            </span>
          </a>
        ),
      },
      {
        header: 'timestamp',
        accessorFn: (blockSet) =>
          // new Date(Number(blockSet.timestamp)).toLocaleString(),
          new Date(Number(blockSet.timestamp)).toISOString(),
        cell: (props) => <pre>{props.getValue<string>()}</pre>,
      },
      {
        header: 'source',
        accessorFn: (blockSet) => blockSet.source,
        cell: (props) => ({
          [FactSource.Genesis]: 'genesis',
          [FactSource.Bootstrap]: 'bootstrap',
          [FactSource.Building]: 'building',
          [FactSource.Local]: 'local',
          [FactSource.Remote]: 'remote',
        }[props.getValue<FactSource>()]),
      },
      {
        header: 'level',
        accessorFn: (blockSet) => blockSet.level,
      },
      {
        header: 'input_count',
        accessorFn: (blockSet) => blockSet.input_count,
      },
      {
        header: 'incl_input_size',
        accessorFn: (blockSet) => blockSet.includedInputs.size,
      },
      {
        header: 'excl_input_size',
        accessorFn: (blockSet) => blockSet.excludedInputs.size,
      },
      {
        header: 'output_count',
        accessorFn: (blockSet) => blockSet.output_count,
      },
      {
        header: 'incl_output_size',
        accessorFn: (blockSet) => blockSet.includedOutputs.size,
      },
      {
        header: 'excl_output_size',
        accessorFn: (blockSet) => blockSet.excludedOutputs.size,
      },

      {
        header: 'left_child',
        accessorFn: (blockSet) => blockSet.left_child,
        cell: (props) => (
          <HashView
            hash={props.getValue<Hash>()}
            setHoveredHash={setHoveredHash}
            setSelectedHash={setSelectedHash}
          />
        ),
      },
      {
        header: 'right_child',
        accessorFn: (blockSet) => blockSet.right_child,
        cell: (props) => (
          <HashView
            hash={props.getValue<Hash>()}
            setHoveredHash={setHoveredHash}
            setSelectedHash={setSelectedHash}
          />
        ),
      },

      {
        header: 'frontier_vote',
        accessorFn: (blockSet) => blockSet.frontier_vote,
        cell: (props) => (
          <HashView
            hash={props.getValue<Hash>()}
            setHoveredHash={setHoveredHash}
            setSelectedHash={setSelectedHash}
          />
        ),
      },
      {
        header: 'votes',
        accessorFn: (blockSet) => blockSet.votes,
      },

      {
        header: 'block size',
        accessorFn: (blockSet) => blockSet.data.byteLength,
      },
      {
        header: 'is valid',
        accessorFn: (blockSet) =>
          CollateralUtil.isValid(
              CollateralUtil.buildTree(blockSet.collateralizations),
            )
            ? 'yes'
            : 'no',
      },
      {
        header: 'collateralizations',
        accessorFn: (blockSet) => blockSet.collateralizations,
        cell: (props) => (
          <ol>
            {props.getValue<Collateralization[]>().map((ctz) => (
              <li>
                <HashView
                  hash={ctz.collateralBlock.hash}
                  setHoveredHash={setHoveredHash}
                  setSelectedHash={setSelectedHash}
                />
              </li>
            ))}
          </ol>
        ),
      },
    ],
    [],
  );

  const [data, setData] = React.useState(() => getBlocks(ctx));
  const refreshData = () => setData(() => getBlocks(ctx));

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowCanExpand: () => true,
    debugTable: true,
  });

  const { rows } = table.getRowModel();

  return (
    <div>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                return (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder ? null : (
                      <div
                        {...{
                          className: header.column.getCanSort()
                            ? 'cursor-pointer select-none'
                            : '',
                          onClick: header.column.getToggleSortingHandler(),
                        }}
                      >
                        <>
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                        </>
                        <>
                          {{
                            asc: ' 🔼',
                            desc: ' 🔽',
                          }[header.column.getIsSorted() as string] ?? null}
                        </>
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowBorderStyle = {
              borderTop: '1px solid silver',
              borderBottom: row.getIsExpanded()
                ? undefined
                : '1px solid silver',
            };
            return (
              <>
                <tr
                  key={row.id}
                  style={row.original.hash.toPrimitive() === hoveredHash
                    ? { ...rowBorderStyle, backgroundColor: '#DDD' }
                    : rowBorderStyle}
                >
                  {row.getVisibleCells().map((cell) => {
                    return (
                      <td key={cell.id} style={{ padding: '0 4px' }}>
                        <>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </>
                      </td>
                    );
                  })}
                </tr>
                {row.getIsExpanded() && (
                  <tr
                    style={row.original.hash.toPrimitive() === hoveredHash
                      ? { backgroundColor: '#DDD' }
                      : { borderBottom: '1px solid silver' }}
                  >
                    {/* 2nd row is a custom 1 cell row */}
                    <td
                      colSpan={row.getVisibleCells().length}
                      style={{ padding: '0 4px' }}
                    >
                      <pre>{ctx.get(Logger).serialize(row.original, 2, 72)}</pre>
                      <pre>Backtrace: {row.original.backtrace}</pre>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
      <div>{rows.length} Rows</div>
      <button onClick={() => refreshData()}>Refresh Data</button>
    </div>
  );
};
