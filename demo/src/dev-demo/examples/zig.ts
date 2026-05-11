import type { Example } from "./index.ts";

export const zig: Example = {
  source: `const scaffold = @import("scaffold");

// Optional; only used when params are passed as an object
pub fn buildParams() void {
    scaffold.requestString("name", .{
        .type = "string/utf8",
        .short_description = "Your name",
    });
}

pub fn run() void {
    var buf: [256]u8 = undefined;
    const greeting = std.fmt.bufPrint(&buf, "Hello {s}", .{scaffold.getParams()}) catch return;
    scaffold.setData("response", greeting);
}
`,
  fetchParams: { kind: "bytes", text: "World" },
  expectedOutput: "Hello World",
};
