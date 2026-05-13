// Aggregator that pulls every native-testable module into a single test
// binary. Rooting the test target here makes `src/` the module path, so
// cross-directory imports inside child files (e.g. `vfs/devfs.zig`'s
// `../prng.zig`) resolve cleanly. Modules that depend on `extern fn`
// host imports (main.zig, scaffold/*) are intentionally absent.

comptime {
    _ = @import("prng.zig");
    _ = @import("state.zig");
    _ = @import("json.zig");
    _ = @import("vfs/vfs.zig");
    _ = @import("vfs/devfs.zig");
    _ = @import("vfs/input_node.zig");
    _ = @import("vfs/memfs.zig");
    _ = @import("scaffold/paths_codec.zig");
    _ = @import("scaffold/setup.zig");
}
