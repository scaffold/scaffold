import React from 'react';
import observationMonitor from '~/ui/observationMonitor.ts';

export default ({ title, desc }: { title: string; desc: string }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const callback = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        observationMonitor.observe(el);
      } else if (ref.current) {
        observationMonitor.unobserve(ref.current);
      }
      ref.current = el;
    },
    [],
  );

  return <div ref={callback}>{title}: {desc}</div>;
};
