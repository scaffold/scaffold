import React from 'react';
import Context from '../sbl/Context.ts';
import Store2 from '../sbl/util/Store2.ts';

export default (
  { ctx, onSelectClass }: {
    ctx: Context;
    onSelectClass: (clz: { new (context: Context): Store2<unknown> }) => void;
  },
) => {
  const [classes, setClasses] = React.useState<
    { new (context: Context): Store2<unknown> }[]
  >([]);

  return (
    <div>
      {classes.map((clz) => (
        <a
          href='#'
          onClick={() => onSelectClass(clz)}
          style={{ marginRight: 8 }}
        >
          {clz.name}
        </a>
      ))}
      <button
        onClick={() =>
          setClasses(
            [...ctx.debugGetAll().entries()]
              .filter(([_constructor, instance]) => instance instanceof Store2)
              .map(([constructor, _instance]) =>
                constructor as { new (context: Context): Store2<unknown> }
              ),
          )}
      >
        Refresh
      </button>
    </div>
  );
};
