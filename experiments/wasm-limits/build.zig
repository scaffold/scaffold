const std = @import("std");

pub fn build(b: *std.Build) void {
    const id = b.option(u32, "id", "Contract ID") orelse 0;

    const target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });

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
}
