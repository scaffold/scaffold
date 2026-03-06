const config = @import("config");

const ID: u32 = config.contract_id;

var state: u32 = ID;

export fn get_id() u32 {
    return ID;
}

export fn get_state() u32 {
    return state;
}

export fn increment() void {
    state += 1;
}

export fn compute(x: u32) u32 {
    return x *% 31 +% ID;
}
