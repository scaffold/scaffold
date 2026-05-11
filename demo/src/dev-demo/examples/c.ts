import type { Example } from "./index.ts";

export const c: Example = {
  source: `#include <scaffold.h>
#include <string.h>

/* Optional; only used when params are passed as an object */
void build_params(void) {
    scaffold_request_string("name", &(scaffold_descriptor_t){
        .type = "string/utf8",
        .short_description = "Your name",
    });
}

void run(void) {
    char buf[256];
    snprintf(buf, sizeof(buf), "Hello %s", scaffold_get_params());
    scaffold_set_data("response", buf);
}
`,
  fetchParams: { kind: "bytes", text: "World" },
  expectedOutput: "Hello World",
};
