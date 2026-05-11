const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    // Target for the Scaffold contract build. Shared memory requires the
    // atomics + bulk_memory features at link time (even when the contract
    // itself never uses atomic ops). The determinism contract is part of the
    // trusted runtime, not a user contract subject to the validator, so it
    // is free to declare shared memory.
    const contract_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .atomics,
            .bulk_memory,
        }),
    });

    const optimize = b.standardOptimizeOption(.{});

    // ---------------------------------------------------------------
    // Standalone tool: bytes-in / bytes-out via host buffers. Used by
    // tests/WasmDeterminism.test.ts.
    // ---------------------------------------------------------------
    const tool_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    const tool_wasm = b.addExecutable(.{
        .name = "wasm-determinism",
        .root_module = tool_mod,
    });
    tool_wasm.entry = .disabled;
    tool_wasm.rdynamic = true;
    tool_wasm.import_memory = true;
    tool_wasm.export_memory = true;
    tool_wasm.initial_memory = 32 * 1024 * 1024;
    tool_wasm.max_memory = 1 << 28;
    tool_wasm.global_base = 1024;
    b.installArtifact(tool_wasm);

    // ---------------------------------------------------------------
    // Scaffold contract: same transform logic exposed via the Scaffold
    // contract ABI (scaffold_env imports + alloc/run exports).
    // ---------------------------------------------------------------
    const contract_mod = b.createModule(.{
        .root_source_file = b.path("src/contract.zig"),
        .target = contract_target,
        .optimize = optimize,
    });

    const contract_wasm = b.addExecutable(.{
        .name = "wasm-determinism-contract",
        .root_module = contract_mod,
    });
    contract_wasm.entry = .disabled;
    contract_wasm.rdynamic = true;
    contract_wasm.import_memory = true;
    contract_wasm.export_memory = true;
    // Scaffold contracts run under the Atomics transport which uses a
    // SharedArrayBuffer-backed memory. The contract's memory import must
    // declare shared to satisfy WebAssembly's link-time match.
    contract_wasm.shared_memory = true;
    // Scaffold ABI default: 16 pages (1 MiB) initial; the host provides this
    // much shared memory. The contract grows as needed up to the per-contract
    // cap (max_memory_pages in the contract's metadata). The default Zig
    // wasm stack is 1 MiB; shrink it to fit comfortably inside 16 pages of
    // initial memory.
    contract_wasm.stack_size = 64 * 1024; // 64 KiB stack
    contract_wasm.initial_memory = 16 * 65536; // 1 MiB
    contract_wasm.max_memory = 4096 * 65536;
    contract_wasm.global_base = 1024;
    b.installArtifact(contract_wasm);
}
