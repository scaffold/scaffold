// export { type default as React } from 'https://esm.sh/react@18.2.0?target=esnext&pin=v135';

// From https://docs.google.com/document/d/1FTascZXT9cxfetuPRT2eXPQKXui4nWFivUnS_335T3U/preview
export type JsonMl = readonly [
  'div' | 'span' | 'ol' | 'li' | 'table' | 'tr' | 'td',
  // React.HTMLAttributes<HTMLElement>,
  { [key: string]: unknown },
  ...(JsonMl | string | ['object', { object: unknown; config: unknown }])[],
];

export interface DevtoolsFormattable {
  _devtoolsFormatHeader(config: unknown): JsonMl | null;
  _devtoolsFormatBody?(config: unknown): JsonMl | null;
}

export const enableDevtoolsFormatter = () => {
  if ((globalThis as any).devtoolsFormatters === undefined) {
    (globalThis as any).devtoolsFormatters = [];
  }
  (globalThis as any).devtoolsFormatters.push({
    header: (obj: DevtoolsFormattable, config: unknown) =>
      '_devtoolsFormatHeader' in obj ? obj._devtoolsFormatHeader(config) : null,
    hasBody: (obj: DevtoolsFormattable) => '_devtoolsFormatBody' in obj,
    body: (obj: DevtoolsFormattable, config: unknown) => obj._devtoolsFormatBody!(config),
  });
};
