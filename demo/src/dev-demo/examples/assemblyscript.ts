import type { Example } from './index.ts';

export const assemblyscript: Example = {
  source: `// Optional; only used when params are passed as an object
export function buildParams(): void {
  scaffold.requestString("name", {
    type: "string/utf8",
    shortDescription: "Your name",
  });
}

export function run(): void {
  scaffold.setData("response", "Hello " + scaffold.getParams());
}
`,
  fetchParams: { kind: 'bytes', text: 'World' },
  expectedOutput: 'Hello World',
};
