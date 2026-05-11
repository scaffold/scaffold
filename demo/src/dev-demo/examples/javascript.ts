import type { Example } from "./index.ts";

export const javascript: Example = {
  source: `// Optional; only used when params are passed as an object
function buildParams() {
  return scaffold.requestString("name", {
    type: "string/utf8",
    shortDescription: "Your name",
  });
}

function run() {
  scaffold.setData("response", "Hello " + scaffold.getParams());
}
`,
  fetchParams: { kind: "bytes", text: "World" },
  expectedOutput: "Hello World",
};
