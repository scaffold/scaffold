import React from 'react';
import Context from '../sbl/Context.ts';
import Logger from '../sbl/Logger.ts';
import Hash, { HashPrimitive } from '../sbl/util/Hash.ts';
import Store2 from '../sbl/util/Store2.ts';

type ObjMap<T> = { [key: string]: T };

export default ({ ctx, name, Table }: {
  ctx: Context;
  name: string;
  Table: {
    new (context: Context): {
      snapshot(): Record<string, Map<HashPrimitive, unknown>>;
    };
  };
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
      {Object.entries(ctx.get(Table).snapshot()).map(([key, map]) => (
        <span key={`${name}.${key}`}>
          <strong>{name}.{key}:</strong>
          <ol>
            {[...map.entries()].map(([key, val]) => (
              <li key={key}>
                <pre>
                  <span onClick={() => toggleSelected(key)}>
                    {selected[key] ? <strong>{key}</strong> : key}
                  </span>: {
                    ctx.get(Logger).serialize(val, selected[key] ? 2 : 0, selected[key] ? 1024 : 72)
                  }
                </pre>
              </li>
            ))}
          </ol>
        </span>
      ))}
    </>
  );
};
