const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    const optimize = b.standardOptimizeOption(.{});

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    const wasm = b.addExecutable(.{
        .name = "wasm-determinism",
        .root_module = mod,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.import_memory = true;
    wasm.export_memory = true;
    // Initial memory must accommodate input (8 MiB) + output (16 MiB) +
    // scratch (4 MiB) + Zig runtime data past __heap_base. Host can grow.
    wasm.initial_memory = 32 * 1024 * 1024; // 32 MiB
    wasm.max_memory = 1 << 28; // 256 MiB
    // Place buffers past static data so the data section doesn't include them.
    wasm.global_base = 1024;

    b.installArtifact(wasm);
}
