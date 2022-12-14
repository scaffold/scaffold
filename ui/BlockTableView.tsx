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
import { Block } from '../sbl/messages.ts';
import { bin2hex } from '../sbl/pathUtils.ts';
import QaDebugger from '../sbl/QaDebugger.ts';
import { BlockRegistry } from '../sbl/registries.ts';
import Hash from '../sbl/util/Hash.ts';

const trunc = (str: string, threshold = 16) =>
  str.length > threshold
    ? `${str.substr(0, threshold)}... [${str.length}]`
    : str;

const RowDetail = ({ name, val }: { name: string; val: string }) => (
  <div>
    {name}: <pre style={{ display: 'inline' }}>{val}</pre>
  </div>
);

export default ({ ctx }: { ctx: Context }) => {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const columns = React.useMemo<ColumnDef<{ key: Hash; val: Block }>[]>(
    () => [
      {
        header: 'hash',
        accessorFn: ({ key }) => key.toHex(),
        cell: (props) => (
          <a href='#' onClick={props.row.getToggleExpandedHandler()}>
            <pre>{trunc(props.getValue<string>())}</pre>
          </a>
        ),
      },
      {
        header: 'verifier contract hash',
        accessorFn: ({ val }) =>
          ctx.get(QaDebugger).debugQuestion(val.verifier)?.dbgContract ||
          val.verifier.contract_hash.toHex(),
        cell: (props) => <pre>{trunc(props.getValue<string>())}</pre>,
      },
      {
        header: 'verifier params',
        accessorFn: ({ val }) => {
          const dbg = ctx.get(QaDebugger).debugQuestion(val.verifier)
            ?.dbgParams;
          return dbg
            ? ctx.get(Logger).serialize(dbg, 0)
            : bin2hex(val.verifier.params);
        },
        cell: (props) => <pre>{trunc(props.getValue<string>())}</pre>,
      },
      {
        header: 'claims',
        accessorFn: ({ val }) => val.claims.length,
      },
      {
        header: 'incentives',
        accessorFn: ({ val }) => val.incentives.length,
      },
      {
        header: 'body',
        accessorFn: ({ val }) => {
          const dbg = ctx.get(QaDebugger).debugAnswer(val)?.dbgAnswer;
          return dbg ? ctx.get(Logger).serialize(dbg, 0) : bin2hex(val.body);
        },
        cell: (props) => <pre>{trunc(props.getValue<string>(), 64)}</pre>,
      },
      {
        header: 'timestamp',
        accessorFn: ({ val }) =>
          new Date(Number(val.timestamp)).toLocaleString(),
        cell: (props) => <pre>{props.getValue<string>()}</pre>,
      },
    ],
    [],
  );

  const [data, setData] = React.useState(() => ctx.get(BlockRegistry).getAll());
  const refreshData = () => setData(() => ctx.get(BlockRegistry).getAll());

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
    },
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
        <table>
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
                  <tr key={row.id}>
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
                        <RowDetail name='Hash' val={row.original.key.toHex()} />
                        {row.original.val.claims.map((claim, idx) => (
                          <RowDetail
                            name={`Claim ${idx}; $${claim.amount}`}
                            val={claim.block_hash.toHex()}
                          />
                        ))}
                        {row.original.val.incentives.map((incentive, idx) => (
                          <>
                            <RowDetail
                              name={`Incentive ${idx}; $${incentive.amount}`}
                              val={incentive.verifier.contract_hash.toHex()}
                            />
                            <RowDetail
                              name={`Incentive ${idx}; params`}
                              val={bin2hex(incentive.verifier.params)}
                            />
                          </>
                        ))}
                        <RowDetail
                          name='Verifier contract hash'
                          val={row.original.val.verifier.contract_hash.toHex()}
                        />
                        <RowDetail
                          name='Verifier params'
                          val={bin2hex(row.original.val.verifier.params)}
                        />
                        <RowDetail
                          name='Body'
                          val={bin2hex(row.original.val.body)}
                        />
                        <RowDetail
                          name='Timestamp'
                          val={new Date(Number(row.original.val.timestamp))
                            .toISOString()}
                        />
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
