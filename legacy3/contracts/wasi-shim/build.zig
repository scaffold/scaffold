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

    // Memory budget. Layout:
    //   0..1 MiB              -- Zig stack (grows down from __stack_pointer
    //                            = 1 MiB, the wasm-ld default)
    //   1 MiB..~1.1 MiB       -- .rodata + .data + BSS (incl. global state)
    //   2 MiB..               -- shim bump arena (see `bump_ptr` in main.zig)
    //
    // The bump arena starts at 2 MiB so it's well clear of BSS (the global
    // `current_state` alone is ~10 KiB and BSS sits right after .data). The
    // largest single allocation is the /scratch memfs arena (64 KiB), and
    // setup.read + state.init together stage maybe ~20 KiB of book-keeping.
    // 4 MiB = 64 pages comfortably covers that with room to grow. No max --
    // the engine may grow if a future feature needs more.
    exe.initial_memory = 64 * 64 * 1024;

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
