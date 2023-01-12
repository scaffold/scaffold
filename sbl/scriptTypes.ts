type Path = Uint8Array[];

export type MkdirExec = {
  at: Path;
};

export type LinkExec = {
  from: Path;
  to: Path;
};

export type WasmExec = {
  execPath: Path;
  args: string[];
  env: Record<string, string>;

  cwd: Path;
  // root: Path; // Don't allow access outside this directory; must be an ancestor of cwd.

  stdinFrom: Path;
  stdoutTo: Path;
  stderrTo: Path;
};

export type JsExec = {
  code: string;
};

/*
export type GeneratorExec= {
  // This is a thing that provides easy testing for generators
  // >
  // TODO: Better type system
}

export type ProvisionExec= {
  // This is a thing that provides easy testing for provisions
  // > contract = /in/params
  // > generator = /in/candidate
  // > params = /in/hint
  // > executes contract(params, generator(params))
  // TODO: Better type system
  // Generators should be just a hint for how to fulfill a contract.
  // They could be a url, ipfs link, or something else.
}
*/

export type Script = {
  cmds: (
    | { mkdir: MkdirExec }
    | { link: LinkExec }
    | { wasm: WasmExec }
    | { js: JsExec }
  )[];
  runtime: number;
};

// export type LocationHint = { url: string };

export type Generator = Script & {
  exposeEvent: boolean;
  exposeSecret: boolean;
};

export type Verifier = Script & {
  exposeHint: boolean;
};

export type Contract = {
  // A contract finds some candidate given params that satisfies:
  verifier?: Verifier; // verifier(params, candidate) == '\x01'
  provision?: true; // (params as Contract)(hint, (candidate as Generator)(hint)) == '\x01'
};

/*
export type Provision= {
  contract: Contract; // Contract/Verifier hash?
  generator: Generator;
}
*/
