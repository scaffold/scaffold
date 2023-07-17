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
import {
  BlockCollateralization,
  BlockExt,
  BlockSource,
} from '../sbl/BlockMeta.ts';
import Context from '../sbl/Context.ts';
import Logger from '../sbl/Logger.ts';
import { bin2hex } from '../sbl/pathUtils.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import Hash, { HashPrimitive } from '../sbl/util/Hash.ts';
import { trunc } from '../sbl/util/string.ts';
import BlockService from '../sbl/BlockService.ts';
import { BlockInput, BlockOutput } from '../sbl/messages.ts';

const styles: { [key: string]: React.CSSProperties } = {
  table: {
    borderCollapse: 'collapse',
  },
  row: {
    borderTop: '1px solid silver',
    borderBottom: '1px solid silver',
  },
};

const RowDetail = ({ name, val }: { name: string; val: string }) => (
  <div>
    {name}: <pre style={{ display: 'inline' }}>{val}</pre>
  </div>
);

const HashView = ({ hash, setSelectedHash }: {
  hash: Hash;
  setSelectedHash: (primitive: HashPrimitive | undefined) => void;
}) => (
  <span style={{ fontFamily: 'monospace' }}>
    <a
      href='#'
      onMouseOver={() => setSelectedHash(hash.toPrimitive())}
      onMouseOut={() => setSelectedHash(undefined)}
    >
      {hash.toHex().slice(0, 10)}
    </a>
  </span>
);

const getBlocks = (
  ctx: Context,
) => [...ctx.get(BlockService).snapshot().blocksByHash.values()];

export default ({ ctx }: { ctx: Context }) => {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [selectedHash, setSelectedHash] = React.useState<HashPrimitive>();

  const columns = React.useMemo<ColumnDef<BlockExt>[]>(
    () => [
      {
        header: 'hash',
        accessorFn: (block) => block.hash.toHex(),
        cell: (props) => (
          <a href='#' onClick={props.row.getToggleExpandedHandler()}>
            <span style={{ fontFamily: 'monospace' }}>
              {props.getValue<string>().slice(0, 10)}
            </span>
          </a>
        ),
      },
      {
        header: 'timestamp',
        accessorFn: (block) =>
          // new Date(Number(block.timestamp)).toLocaleString(),
          new Date(Number(block.timestamp)).toISOString(),
        cell: (props) => <pre>{props.getValue<string>()}</pre>,
      },
      {
        header: 'source',
        accessorFn: (block) => block.source,
        cell: (props) => ({
          [BlockSource.Bootstrap]: 'bootstrap',
          [BlockSource.Local]: 'local',
          [BlockSource.Remote]: 'remote',
        }[props.getValue<BlockSource>()]),
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
              const output = ctx.get(BlockService).get(input.block_hash)
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
                      setSelectedHash={setSelectedHash}
                    />.{input.output_idx}
                    {output
                      ? `: ${
                        ctx.get(QaDebugger).debugQuestion(output.verifier)
                          ?.dbgContract ??
                          output.verifier.contract_hash.toHex().slice(0, 10)
                      }/${
                        Hash.digest(output.verifier.params).toHex().slice(0, 10)
                      }`
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
            {props.getValue<BlockExt>().outputs.map((output, outputIdx) => {
              const claims = props.getValue<BlockExt>().outputClaims[outputIdx];

              return (
                <li>
                  <span
                    style={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}
                  >
                    ${Number(output.amount)}
                    {': '}
                    {ctx.get(QaDebugger).debugQuestion(output.verifier)
                      ?.dbgContract ??
                      output.verifier.contract_hash.toHex().slice(0, 10)}/{Hash
                      .digest(output.verifier.params).toHex().slice(0, 10)}
                    {claims.length
                      ? (
                        <>
                          {claims.flatMap((claim, idx) => [
                            idx ? '; ' : ': ',
                            <HashView
                              hash={claim.hash}
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
        header: 'block size',
        accessorFn: (block) => block.data.byteLength,
      },
      {
        header: 'collateral for',
        accessorFn: (block) =>
          block.collateralizations.reduce(
            (acc, cur) => cur.params.valid ? acc + cur.amountDelta : acc,
            0n,
          ),
      },
      {
        header: 'collateral against',
        accessorFn: (block) =>
          block.collateralizations.reduce(
            (acc, cur) => cur.params.valid ? acc : acc + cur.amountDelta,
            0n,
          ),
      },
      {
        header: 'collateralizations',
        accessorFn: (block) => block.collateralizations,
        cell: (props) => (
          <ol>
            {props.getValue<BlockCollateralization[]>().map((ctz) => (
              <li>
                <HashView
                  hash={ctz.block.hash}
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

  const tableContainerRef = React.useRef<HTMLDivElement>(null);

  const { rows } = table.getRowModel();
  const rowVirtualizer = useVirtual({
    parentRef: tableContainerRef,
    size: rows.length,
    overscan: 10,
  });
  const { virtualItems: virtualRows, totalSize } = rowVirtualizer;

  const paddingTop = virtualRows.length > 0 ? virtualRows?.[0]?.start || 0 : 0;
  const paddingBottom = virtualRows.length > 0
    ? totalSize - (virtualRows?.[virtualRows.length - 1]?.end || 0)
    : 0;

  return (
    <div className='p-2'>
      <div className='h-2' />
      <div ref={tableContainerRef} className='container'>
        <table style={styles.table}>
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
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {{
                            asc: ' 🔼',
                            desc: ' 🔽',
                          }[header.column.getIsSorted() as string] ?? null}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td style={{ height: `${paddingTop}px` }} />
              </tr>
            )}
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              return (
                <>
                  <tr
                    key={row.id}
                    style={row.original.hash.toPrimitive() === selectedHash
                      ? { ...styles.row, backgroundColor: '#DDD' }
                      : styles.row}
                  >
                    {row.getVisibleCells().map((cell) => {
                      return (
                        <td key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {row.getIsExpanded() && (
                    <tr>
                      {/* 2nd row is a custom 1 cell row */}
                      <td colSpan={row.getVisibleCells().length}>
                        <pre>{ctx.get(Logger).serialize(row.original, 2, 72)}</pre>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td style={{ height: `${paddingBottom}px` }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div>{table.getRowModel().rows.length} Rows</div>
      <div>
        <button onClick={() => refreshData()}>Refresh Data</button>
      </div>
    </div>
  );
};
