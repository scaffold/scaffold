import type { Example } from './index.ts';

export const rust: Example = {
  source: `// Optional; only used when params are passed as an object
fn build_params() {
    scaffold::request_string("name", scaffold::Descriptor {
        kind: "string/utf8",
        short_description: "Your name",
    });
}

fn run() {
    let greeting = format!("Hello {}", scaffold::get_params());
    scaffold::set_data("response", &greeting);
}
`,
  fetchParams: { kind: 'bytes', text: 'World' },
  expectedOutput: 'Hello World',
};
