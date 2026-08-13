import type { Example } from './index.ts';

export const go: Example = {
  source: `// Optional; only used when params are passed as an object
func buildParams() {
    return scaffold.RequestString("name", scaffold.Descriptor{
        Type: "string/utf8",
        ShortDescription: "Your name",
    })
}

func run() {
    scaffold.SetData("response", "Hello " + scaffold.GetParams())
}
`,
  fetchParams: { kind: 'bytes', text: 'World' },
  expectedOutput: 'Hello World',
};
