import { type React } from '../deps.ts';

// From https://docs.google.com/document/d/1FTascZXT9cxfetuPRT2eXPQKXui4nWFivUnS_335T3U/preview
export type JsonMl = readonly [
  'div' | 'span' | 'ol' | 'li' | 'table' | 'tr' | 'td',
  React.HTMLAttributes<HTMLElement>,
  ...(JsonMl | string | ['object', { object: unknown; config: unknown }])[],
];

export interface DevtoolsFormattable {
  _devtoolsFormatHeader(config: unknown): JsonMl | null;
  _devtoolsFormatBody?(config: unknown): JsonMl | null;
}

export const enableDevtoolsFormatter = () => {
  if ((window as any).devtoolsFormatters === undefined) {
    (window as any).devtoolsFormatters = [];
  }
  (window as any).devtoolsFormatters.push({
    header: (obj: DevtoolsFormattable, config: unknown) =>
      '_devtoolsFormatHeader' in obj ? obj._devtoolsFormatHeader(config) : null,
    hasBody: (obj: DevtoolsFormattable) => '_devtoolsFormatBody' in obj,
    body: (obj: DevtoolsFormattable, config: unknown) =>
      obj._devtoolsFormatBody!(config),
  });
};
