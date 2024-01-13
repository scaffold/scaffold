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
import { BlockFact, Collateralization, FactSource } from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import BlockService from '~/sbl/BlockService.ts';
import HashView from '~/ui/HashView.tsx';
import CollateralUtil from '~/sbl/CollateralUtil.ts';
import WeightService from '~/sbl/WeightService.ts';
import BalanceService from '~/sbl/BalanceService.ts';

const RowDetail = ({ name, val }: { name: string; val: string }) => (
  <div>
    {name}: <pre style={{ display: 'inline' }}>{val}</pre>
  </div>
);

const getBlocks = (ctx: Context) =>
  ctx.get(FactService).hackyGetBlocksMatching();

const wrapAccessor =
  <T,>(fn: (block: BlockFact) => T) => (block: BlockFact) => {
    try {
      return fn(block);
    } catch (err) {
      console.error(err);
      return '?';
    }
  };

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

  const columns = React.useMemo<ColumnDef<BlockFact>[]>(
    () => [
      {
        header: 'hash',
        accessorFn: (block) => block.hash.toHex(),
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
        header: 'name',
        accessorFn: (block) => block.sillyName,
      },
      // {
      //   header: 'timestamp',
      //   accessorFn: (block) =>
      //     // new Date(Number(block.timestamp)).toLocaleString(),
      //     new Date(Number(block.timestamp)).toISOString(),
      //   cell: (props) => <pre>{props.getValue<string>()}</pre>,
      // },
      {
        header: 'source',
        accessorFn: (block) => block.source,
        cell: (props) => ({
          [FactSource.Genesis]: 'genesis',
          [FactSource.Bootstrap]: 'bootstrap',
          // [FactSource.Building]: 'building',
          [FactSource.Local]: 'local',
          [FactSource.Remote]: 'remote',
          [FactSource.Storage]: 'storage',
        }[props.getValue<FactSource>()]),
      },
      // {
      //   header: 'verifier contract hash',
      //   accessorFn: ({ val }) =>
      //     ctx.get(QaDebugger).debugQuestion(val.verifier)?.dbgContract ||
      //     val.verifier.contract_hash.toHex(),
      //   cell: (props) => <pre>{trunc(props.getValue<string>())}</pre>,
      // },
      // {
      //   header: 'verifier params',
      //   accessorFn: ({ val }) => {
      //     const dbg = ctx.get(QaDebugger).debugQuestion(val.verifier)
      //       ?.dbgParams;
      //     return dbg
      //       ? ctx.get(Logger).serialize(dbg, 0)
      //       : bin2hex(val.verifier.params);
      //   },
      //   cell: (props) => <pre>{trunc(props.getValue<string>())}</pre>,
      // },

      // input:
      // $50: 7786d3c1b2.0: accountHash/78c87b2352

      {
        header: 'inputs',
        accessorFn: (block) => block.inputs,
        cell: (props) => (
          <ol>
            {props.getValue<BlockInput[]>().map((input) => {
              const output = ctx.get(BlockService).get(input.block_hash, false)
                ?.outputs[input.output_idx];
              return (
                <li>
                  <span
                    style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}
                  >
                    ${output ? Number(output.amount) : '?'}
                    {': '}
                    <HashView
                      hash={input.block_hash}
                      setHoveredHash={setHoveredHash}
                      setSelectedHash={setSelectedHash}
                    />.{input.output_idx}
                    {output
                      ? `: ${
                        ctx.get(QaDebugger).debugQuestion(output.verifier)
                          ?.dbgContract ??
                          output.verifier.contract_hash.toHex().slice(0, 10)
                      }/${bin2hex(output.verifier.params).slice(0, 10)}`
                      : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ),
      },

      // output:
      // $50: accountHash/78c87b2352: 7786d3c1b2.0; 7786d3c1b2.1

      {
        header: 'outputs',
        accessorFn: (block) => block,
        cell: (props) => (
          <ol>
            {props.getValue<BlockFact>().outputs.map((output, outputIdx) => {
              const claims =
                props.getValue<BlockFact>().outputClaims[outputIdx];

              return (
                <li>
                  <span
                    style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}
                  >
                    ${Number(output.amount)}
                    {': '}
                    {ctx.get(QaDebugger).debugQuestion(output.verifier)
                      ?.dbgContract ??
                      output.verifier.contract_hash.toHex().slice(0, 10)}/
                    {bin2hex(output.verifier.params).slice(0, 10)}
                    {claims.length
                      ? (
                        <>
                          {claims.flatMap((claim, idx) => [
                            idx ? '; ' : ': ',
                            <HashView
                              hash={claim.block.hash}
                              setHoveredHash={setHoveredHash}
                              setSelectedHash={setSelectedHash}
                            />,
                          ])}
                        </>
                      )
                      : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ),
      },
      {
        header: 'throughput',
        accessorFn: (block) =>
          block.outputs.reduce((acc, output) => acc + output.amount, 0n),
      },
      {
        header: 'body size',
        accessorFn: (block) => block.body.byteLength,
      },
      {
        header: 'body',
        accessorFn: (block) => {
          const dbg = ctx.get(QaDebugger).debugAnswer(block)?.dbgAnswer;
          return dbg ? ctx.get(Logger).serialize(dbg, 0) : bin2hex(block.body);
        },
        cell: (props) => <pre>{trunc(props.getValue<string>(), 16)}</pre>,
      },
      {
        header: 'frontier_vote',
        accessorFn: (block) => block.frontier_vote,
        cell: (props) => (
          <HashView
            hash={props.getValue<Hash>()}
            setHoveredHash={setHoveredHash}
            setSelectedHash={setSelectedHash}
          />
        ),
      },
      {
        header: 'block size',
        accessorFn: (block) => block.data.byteLength,
      },
      {
        header: 'collateralizations',
        accessorFn: (block) => block.collateralizations,
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
      {
        header: 'is valid',
        accessorFn: (block) =>
          CollateralUtil.isValid(
              CollateralUtil.buildTree(block.collateralizations),
            )
            ? 'yes'
            : 'no',
      },
      {
        header: 'canonicality',
        accessorFn: wrapAccessor((block) =>
          ctx.get(WeightService).getCanonicality(block)
        ),
        cell: (props) => {
          const x = props.getValue<bigint | string>();
          if (typeof x === 'string') {
            return x;
          } else if (x >= 0) {
            return <strong>{Number(x)}</strong>;
          } else {
            return Number(x);
          }
        },
      },
      {
        header: 'ancestor weight',
        accessorFn: wrapAccessor((block) =>
          ctx.get(WeightService).getAncestorWeight(block).minWeight
        ),
      },
      {
        header: 'tree weights',
        accessorFn: wrapAccessor((block) =>
          block.frontierDetail.tree_weights.join(',')
        ),
      },
      {
        header: 'self weight min',
        accessorFn: wrapAccessor((block) =>
          ctx.get(WeightService).getSelfWeight(block).minWeight
        ),
      },
      {
        header: 'self weight max',
        accessorFn: wrapAccessor((block) =>
          ctx.get(WeightService).getSelfWeight(block).maxWeight
        ),
      },
      {
        header: 'descendant weight',
        accessorFn: wrapAccessor((block) =>
          ctx.get(WeightService).getDescendantWeight(block).minWeight
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
      Balance: ${Number(ctx.get(BalanceService).getLiquidBalance())}
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
