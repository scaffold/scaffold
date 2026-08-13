import type { Example } from './index.ts';

export const cpp: Example = {
  source: `#include <scaffold.h>
#include <string>

// Optional; only used when params are passed as an object
void buildParams() {
    scaffold::requestString("name", {
        .type = "string/utf8",
        .shortDescription = "Your name",
    });
}

void run() {
    std::string greeting = "Hello " + scaffold::getParams();
    scaffold::setData("response", greeting);
}
`,
  fetchParams: { kind: 'bytes', text: 'World' },
  expectedOutput: 'Hello World',
};
