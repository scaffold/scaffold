import React from 'react';
import Context from '../sbl/Context.ts';
import Logger from '../sbl/Logger.ts';
import Hash, { HashPrimitive } from '../sbl/util/Hash.ts';
import Store2 from '../sbl/util/Store2.ts';
import BlockService from '../sbl/BlockService.ts';

type ObjMap<T> = { [key: string]: T };

export default ({ ctx, name, Table, filter }: {
  ctx: Context;
  name: string;
  Table: {
    new (context: Context): {
      snapshot(): Record<string, Map<HashPrimitive, unknown>>;
    };
  };
  filter?: string;
}) => {
  const [selected, toggleSelected] = React.useReducer(
    (state: ObjMap<boolean>, key: string): ObjMap<boolean> => ({
      ...state,
      [key]: !state[key],
    }),
    {},
  );

  return (
    <>
      {Object.entries(ctx.get(BlockService).snapshot()).map(([key, map]) => (
        <span key={`${name}.${key}`}>
          <strong>{name}.{key}:</strong>
          <table>
            <thead>
              <tr>
                <th>Hash</th>
                <th># of inputs</th>
                <th># of outputs</th>
                <th>Inputs</th>
                <th>Outputs</th>
                <th>Timestamp</th>
                <th>Throughput</th>
                <th>Body size</th>
                <th>Body parsed</th>
                <th>Block size</th>
                <th>Collateral for</th>
                <th>Collateral against</th>
                <th>Collateralizations</th>
              </tr>
            </thead>
            <tbody>
              {[...map.entries()].filter(
                filter
                  ? ([key, val]) =>
                    key.includes(filter) ||
                    ctx.get(Logger).serialize(val, 0, 1024).includes(filter)
                  : () => true,
              ).map(([key, val]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </span>
      ))}
    </>
  );
};
