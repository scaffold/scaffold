import React from 'react';
import Context from '../sbl/Context.ts';
import Logger from '../sbl/Logger.ts';
import Hash from '../sbl/util/Hash.ts';
import Store2 from '../sbl/util/Store2.ts';

type ObjMap<T> = { [key: string]: T };

export default ({ ctx, Table }: {
  ctx: Context;
  Table: { new (context: Context): Store2<any> };
}) => {
  const [selected, toggleSelected] = React.useReducer(
    (state: ObjMap<boolean>, key: string): ObjMap<boolean> => ({
      ...state,
      [key]: !state[key],
    }),
    {},
  );

  const [state, dispatch] = React.useReducer(
    (
      state: ObjMap<any>,
      { hash, value }: { hash: Hash; value: any },
    ): ObjMap<any> => ({ ...state, [hash.toHex()]: value }),
    {},
  );
  React.useEffect(() => {
    ctx.get(Table).onMutate((hash, _, value) => dispatch({ hash, value }));
  }, []);

  return (
    <ol>
      {Object.entries(state).map(([key, val]) => (
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
  );
};
