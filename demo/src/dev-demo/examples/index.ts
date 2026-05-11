import { assemblyscript } from "./assemblyscript.ts";
import { typescript } from "./typescript.ts";
import { javascript } from "./javascript.ts";
import { go } from "./go.ts";
import { python } from "./python.ts";
import { zig } from "./zig.ts";
import { rust } from "./rust.ts";
import { cpp } from "./cpp.ts";
import { c } from "./c.ts";
import { sqlite } from "./sqlite.ts";

export type Lang =
  | "typescript"
  | "javascript"
  | "go"
  | "python"
  | "zig"
  | "rust"
  | "cpp"
  | "c"
  | "assemblyscript"
  | "sqlite";

export interface LanguageMeta {
  id: Lang;
  label: string;
  /** Monaco language id (may differ from Lang id, e.g. 'cpp' === 'cpp'). */
  monacoId: string;
  /** Filename used in the `files` map passed to the compiler contract. */
  filename: string;
}

export const LANGUAGES: LanguageMeta[] = [
  {
    id: "typescript",
    label: "TypeScript",
    monacoId: "typescript",
    filename: "/main.ts",
  },
  {
    id: "javascript",
    label: "JavaScript",
    monacoId: "javascript",
    filename: "/main.js",
  },
  { id: "go", label: "Go", monacoId: "go", filename: "/main.go" },
  { id: "python", label: "Python", monacoId: "python", filename: "/main.py" },
  { id: "zig", label: "Zig", monacoId: "zig", filename: "/main.zig" },
  { id: "rust", label: "Rust", monacoId: "rust", filename: "/main.rs" },
  { id: "cpp", label: "C++", monacoId: "cpp", filename: "/main.cpp" },
  { id: "c", label: "C", monacoId: "c", filename: "/main.c" },
  {
    id: "assemblyscript",
    label: "AssemblyScript",
    monacoId: "assemblyscript",
    filename: "/main.ts",
  },
  { id: "sqlite", label: "Sqlite", monacoId: "sql", filename: "/main.sql" },
];

export interface Example {
  source: string;
  /**
   * Initial params for the second-Run "call the compiled contract" snippet.
   * 'bytes' renders as `new TextEncoder().encode('...')`; 'object' renders as
   * a JSON-shaped TS object literal.
   */
  fetchParams:
    | { kind: "bytes"; text: string }
    | { kind: "object"; obj: Record<string, unknown> };
  /** Shown as the placeholder hint in the output panel. */
  expectedOutput: string;
}

export const EXAMPLES: Record<Lang, Example> = {
  assemblyscript,
  typescript,
  javascript,
  go,
  python,
  zig,
  rust,
  cpp,
  c,
  sqlite,
};
