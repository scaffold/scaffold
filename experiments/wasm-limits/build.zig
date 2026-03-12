const std = @import("std");

pub fn build(b: *std.Build) void {
    const id = b.option(u32, "id", "Contract ID") orelse 0;

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

    // Original contract with compile-time ID
    const options = b.addOptions();
    options.addOption(u32, "contract_id", id);

    const mod = b.createModule(.{
        .root_source_file = b.path("contract.zig"),
        .target = target,
        .optimize = .ReleaseSmall,
    });
    mod.addOptions("config", options);

    const wasm = b.addExecutable(.{
        .name = "contract",
        .root_module = mod,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;

    b.installArtifact(wasm);

    // JSON serializer
    const json_mod = b.createModule(.{
        .root_source_file = b.path("json_serializer.zig"),
        .target = target,
        .optimize = .ReleaseSmall,
    });

    const json_wasm = b.addExecutable(.{
        .name = "json_serializer",
        .root_module = json_mod,
    });
    json_wasm.entry = .disabled;
    json_wasm.rdynamic = true;

    b.installArtifact(json_wasm);

    // JSON stdlib serializer
    const json_std_mod = b.createModule(.{
        .root_source_file = b.path("json_stdlib.zig"),
        .target = target,
        .optimize = .ReleaseSmall,
    });

    const json_std_wasm = b.addExecutable(.{
        .name = "json_stdlib",
        .root_module = json_std_mod,
    });
    json_std_wasm.entry = .disabled;
    json_std_wasm.rdynamic = true;

    b.installArtifact(json_std_wasm);
}
