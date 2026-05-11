import type { Example } from "./index.ts";

export const python: Example = {
  source: `# Optional; only used when params are passed as an object
def build_params():
    return scaffold.request_string("name", {
        "type": "string/utf8",
        "short_description": "Your name",
    })

def run():
    scaffold.set_data("response", "Hello " + scaffold.get_params())
`,
  fetchParams: { kind: "bytes", text: "World" },
  expectedOutput: "Hello World",
};
