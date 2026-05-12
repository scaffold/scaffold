// Build script for the WASI shim. Produces `dist/wasi-shim.wasm`.
//
// Run with `zig build -Doptimize=ReleaseSmall` to produce the shipping blob,
// or plain `zig build` for a debug build with panic handlers.
//
// The shim targets `wasm32-freestanding` -- it is the thing implementing
// WASI, so it does not itself depend on a WASI runtime. All host calls go
// through `scaffold_env.*` (to scaffold) and `program_mem.*` / `program.*`
// (to the program layer above it in the stacking graph).

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });
    const optimize = b.standardOptimizeOption(.{
        .preferred_optimize_mode = .ReleaseSmall,
    });

    const exe = b.addExecutable(.{
        .name = "wasi-shim",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.entry = .disabled; // no _start; `run` is invoked by scaffold
    exe.rdynamic = true; // keep all `export fn` visible without manual --export

    // Drop directly into dist/wasi-shim.wasm so the TS setup helper has a
    // stable path. We bypass the default zig-out/bin/ layout because the
    // shipping artifact is a single .wasm, not a binary tree.
    const install = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .{ .custom = "../dist" } },
    });
    b.getInstallStep().dependOn(&install.step);

    const wasi_shim_step = b.step("wasi-shim", "Build the WASI shim WASM blob");
    wasi_shim_step.dependOn(&install.step);

    // Native unit tests. The shim itself builds for wasm32-freestanding, but
    // the pure-logic modules (vfs, prng, state, json, ...) are exercised on
    // the host. We root the test module at `src/tests.zig` so cross-directory
    // imports like `../prng.zig` from `vfs/devfs.zig` resolve within the
    // module path.
    const test_step = b.step("test", "Run native unit tests for non-extern modules");
    const native_target = b.graph.host;
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tests.zig"),
            .target = native_target,
            .optimize = optimize,
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    test_step.dependOn(&run_tests.step);
}
