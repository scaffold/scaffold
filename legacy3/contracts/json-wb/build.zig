const std = @import("std");

// Build the generic JSON walker/builder contract module (json-wb.wasm).
// Mirrors the wasi-shim build: wasm32-freestanding, no entry, export-all,
// exports its own linear memory so the host/stacking linker can read the build
// result and write request replies via `alloc`.

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });
    const optimize = b.standardOptimizeOption(.{
        .preferred_optimize_mode = .ReleaseSmall,
    });

    const exe = b.addExecutable(.{
        .name = "json-wb",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.entry = .disabled;
    exe.rdynamic = true;

    // Stack + static data below 2 MiB; bump arena from 2 MiB up (see main.zig).
    exe.initial_memory = 64 * 64 * 1024;

    const install = b.addInstallArtifact(exe, .{
        .dest_dir = .{ .override = .{ .custom = "../dist" } },
    });
    b.getInstallStep().dependOn(&install.step);

    const json_wb_step = b.step("json-wb", "Build the json-wb WASM blob");
    json_wb_step.dependOn(&install.step);
}
