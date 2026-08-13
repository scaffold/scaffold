// Side-effect module: registers Monaco token providers for languages that
// don't ship in monaco-editor's standard build. Other languages used by the
// dev demo (typescript, javascript, go, rust, python, c, cpp, sql) come from
// monaco-editor's built-in basic-languages set and don't need registration.
//
// These grammars are intentionally minimal (keywords + comments + strings +
// numbers) -- enough for syntax tone, no LSP. Mirrors what Monaco does for
// other "basic" languages in its bundle.

import './monacoSetup.ts';
import * as monaco from 'monaco-editor';

let registered = false;

export function registerDevDemoGrammars() {
  if (registered) return;
  registered = true;

  registerAssemblyScript();
  registerZig();
}

function registerAssemblyScript() {
  monaco.languages.register({ id: 'assemblyscript', extensions: ['.ts'] });
  // AssemblyScript is a strict subset of TypeScript -- reuse TS tokenization.
  // We don't set a custom tokens provider; instead default to TypeScript's
  // grammar by aliasing. Monaco doesn't expose an alias API, so we register
  // a tiny Monarch tokenizer that defers visually.
  monaco.languages.setMonarchTokensProvider('assemblyscript', {
    defaultToken: '',
    keywords: [
      'function',
      'let',
      'const',
      'var',
      'if',
      'else',
      'for',
      'while',
      'do',
      'return',
      'break',
      'continue',
      'class',
      'interface',
      'extends',
      'implements',
      'new',
      'this',
      'super',
      'true',
      'false',
      'null',
      'void',
      'export',
      'import',
      'as',
      'from',
      'type',
      'enum',
      'i8',
      'i16',
      'i32',
      'i64',
      'u8',
      'u16',
      'u32',
      'u64',
      'f32',
      'f64',
      'bool',
      'string',
      'Array',
      'static',
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@blockComment'],
        [/"[^"]*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[a-zA-Z_]\w*/, {
          cases: { '@keywords': 'keyword', '@default': 'identifier' },
        }],
        [/[{}()\[\]<>]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
      ],
      blockComment: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/./, 'comment'],
      ],
    },
  });
}

function registerZig() {
  monaco.languages.register({ id: 'zig', extensions: ['.zig'] });
  monaco.languages.setMonarchTokensProvider('zig', {
    defaultToken: '',
    keywords: [
      'fn',
      'pub',
      'const',
      'var',
      'if',
      'else',
      'while',
      'for',
      'switch',
      'return',
      'break',
      'continue',
      'struct',
      'enum',
      'union',
      'error',
      'try',
      'catch',
      'defer',
      'errdefer',
      'comptime',
      'inline',
      'export',
      'extern',
      'volatile',
      'unreachable',
      'undefined',
      'null',
      'true',
      'false',
      'and',
      'or',
      'orelse',
      'test',
      'usingnamespace',
      'i8',
      'i16',
      'i32',
      'i64',
      'i128',
      'u8',
      'u16',
      'u32',
      'u64',
      'u128',
      'usize',
      'isize',
      'f16',
      'f32',
      'f64',
      'f128',
      'bool',
      'void',
      'noreturn',
      'type',
      'anyerror',
      'anytype',
      'anyframe',
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/"[^"]*"/, 'string'],
        [/'\\?.'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/@[a-zA-Z_]\w*/, 'keyword.builtin'],
        [/[a-zA-Z_]\w*/, {
          cases: { '@keywords': 'keyword', '@default': 'identifier' },
        }],
        [/[{}()\[\]]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
      ],
    },
  });
}
