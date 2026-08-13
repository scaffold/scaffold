import type { Example } from './index.ts';

export const sqlite: Example = {
  source: `-- Optional; only used when params are passed as an object
-- buildParams: declares a 'name' string input
CREATE TABLE IF NOT EXISTS params (
    name TEXT
);

-- run: produces a 'response' record output
SELECT 'Hello ' || (SELECT name FROM params LIMIT 1) AS response;
`,
  fetchParams: { kind: 'bytes', text: 'World' },
  expectedOutput: 'Hello World',
};
