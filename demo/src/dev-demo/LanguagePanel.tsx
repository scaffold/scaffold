import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Scaffold } from "scaffold.io/Scaffold.ts";
import type { Hash } from "scaffold.io/util/Hash.ts";
import { CodeEditorField } from "./CodeEditorField.tsx";
import { RunButton, type RunState } from "./RunButton.tsx";
import { HashLine } from "./HashLine.tsx";
import { OutputPanel } from "./OutputPanel.tsx";
import { EXAMPLES, type Lang, LANGUAGES } from "./examples/index.ts";

interface LanguagePanelProps {
  scaffold: Scaffold;
  lang: Lang;
  /** Per-language compiler block hash (echo placeholder for v1). */
  compilerHash: Hash | null;
  onHashClick: (hash: Hash) => void;
}

const INIT_SNIPPET = `const scaffold = new Scaffold({
  bootstrap: ['relay.scaffold.io'], // Only used to dial WebRTC connections
});
`;

function renderCompileSnippet(
  filename: string,
  compilerHash: Hash | null,
  source: string,
): string {
  const indented = source.replace(/^/gm, "      ").replace(/^[ ]{6}$/gm, "");
  return `scaffold.fetch({
  contract: '${
    compilerHash ? "0x" + compilerHash.toHex() : "<compiler not loaded>"
  }',
  params: {
    files: {
      '${filename}': \`
${indented}\`,
    },
    options: {},
  },
  onClaim: ({ block }) => console.log(block.hash),
});
`;
}

function renderCallSnippet(
  contractHash: Hash | null,
  paramText: string,
): string {
  return `scaffold.fetch({
  contract: '${
    contractHash ? "0x" + contractHash.toHex() : "<run compile first>"
  }',
  params: new TextEncoder().encode(${JSON.stringify(paramText)}),
  onResult: ({ data }) => console.log(new TextDecoder().decode(data)),
});
`;
}

export function LanguagePanel({
  scaffold,
  lang,
  compilerHash,
  onHashClick,
}: LanguagePanelProps) {
  const langMeta = useMemo(() => LANGUAGES.find((l) => l.id === lang)!, [lang]);
  const example = EXAMPLES[lang];

  const [source, setSource] = useState(example.source);
  const [compileState, setCompileState] = useState<RunState>({ kind: "idle" });
  const [compiledHash, setCompiledHash] = useState<Hash | null>(null);

  const [callSnippetUserEdited, setCallSnippetUserEdited] = useState(false);
  const initialParamText = example.fetchParams.kind === "bytes"
    ? example.fetchParams.text
    : JSON.stringify(example.fetchParams.obj);
  const [callSnippet, setCallSnippet] = useState(
    renderCallSnippet(compiledHash, initialParamText),
  );
  const [callState, setCallState] = useState<RunState>({ kind: "idle" });
  const [callOutput, setCallOutput] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  // Auto-regenerate the call snippet when the compile output changes,
  // unless the user has manually edited it.
  useEffect(() => {
    if (!callSnippetUserEdited) {
      setCallSnippet(renderCallSnippet(compiledHash, initialParamText));
    }
  }, [compiledHash, callSnippetUserEdited, initialParamText]);

  const compileSnippet = useMemo(
    () => renderCompileSnippet(langMeta.filename, compilerHash, source),
    [langMeta.filename, compilerHash, source],
  );

  const runCompile = useCallback(async () => {
    if (!compilerHash) {
      setCompileState({
        kind: "error",
        message: "Compiler contract not loaded yet",
      });
      return;
    }
    setCompileState({ kind: "compiling" });
    try {
      // Placeholder: with the C0 echo contract, the fetch returns the source
      // bytes back. The displayed hash is the compiler contract itself --
      // when real per-language compilers land (C1+) the compile call will
      // resolve to a freshly produced block whose `record('wasm', ...)` is
      // the compiled output, and `compiledHash` will be set from that block.
      const sourceBytes = new TextEncoder().encode(source);
      const result = await scaffold.fetch({
        contract: compilerHash,
        params: sourceBytes,
        recordKey: "echo",
        verify: true,
      });
      // Force-await parse to surface any walker errors.
      await result.parse().catch(() => undefined);
      setCompiledHash(compilerHash);
      setCompileState({ kind: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scaffold.eventLog?.append(
        "dev-demo",
        "compile_failed",
        { lang, message },
        "warn",
      );
      setCompileState({ kind: "error", message });
    }
  }, [scaffold, lang, source, compilerHash]);

  const runCall = useCallback(async () => {
    if (!compilerHash || !compiledHash) {
      setCallState({
        kind: "error",
        message: "Run compile first",
      });
      return;
    }
    setCallState({ kind: "compiling" });
    setCallError(null);
    try {
      const paramText = example.fetchParams.kind === "bytes"
        ? example.fetchParams.text
        : JSON.stringify(example.fetchParams.obj);
      const paramBytes = new TextEncoder().encode(paramText);
      // With the C0 echo placeholder, both runs target the same compiler
      // contract. When real compilers land, this call will instead target
      // `compiledHash` -- the freshly produced contract block.
      const result = await scaffold.fetch({
        contract: compilerHash,
        params: paramBytes,
        recordKey: "echo",
        verify: true,
      });
      const decoded = new TextDecoder().decode(result.body);
      setCallOutput(decoded);
      setCallState({ kind: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scaffold.eventLog?.append(
        "dev-demo",
        "call_failed",
        { lang, message },
        "warn",
      );
      setCallError(message);
      setCallState({ kind: "error", message });
    }
  }, [scaffold, lang, compilerHash, compiledHash, example]);

  return (
    <div style={panelStyle}>
      <Section title="1. Initialize Scaffold">
        <CodeEditorField
          language="typescript"
          value={INIT_SNIPPET}
          readOnly
          height="5rem"
        />
      </Section>

      <Section title={`2. Write ${langMeta.label}`}>
        <CodeEditorField
          language={langMeta.monacoId}
          value={source}
          onChange={setSource}
          height="14rem"
          lineNumbers
        />
      </Section>

      <Section
        title="3. Compile via Scaffold"
        inlineAction={<RunButton state={compileState} onClick={runCompile} />}
      >
        <CodeEditorField
          language="typescript"
          value={compileSnippet}
          readOnly
          height="12rem"
        />
        {compileState.kind === "error" && (
          <div style={errorRowStyle}>{compileState.message}</div>
        )}
      </Section>

      <Section title="4. Compile output">
        <HashLine
          hash={compiledHash}
          onClick={onHashClick}
        />
      </Section>

      <Section
        title="5. Call the compiled contract"
        inlineAction={
          <RunButton
            state={callState}
            onClick={runCall}
            disabled={compiledHash === null}
            disabledReason="Run compile first"
          />
        }
      >
        <CodeEditorField
          language="typescript"
          value={callSnippet}
          onChange={(v) => {
            setCallSnippet(v);
            setCallSnippetUserEdited(true);
          }}
          height="7rem"
        />
      </Section>

      <Section title="6. Output">
        <OutputPanel
          value={callOutput}
          error={callError}
          placeholder="Run to populate"
        />
      </Section>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  inlineAction?: React.ReactNode;
}

function Section({ title, children, inlineAction }: SectionProps) {
  return (
    <div style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <span style={sectionTitleStyle}>{title}</span>
        {inlineAction && <div style={sectionActionStyle}>{inlineAction}</div>}
      </div>
      <div style={sectionBodyStyle}>{children}</div>
    </div>
  );
}

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "16px 24px 32px",
  maxWidth: 880,
  margin: "0 auto",
};

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const sectionTitleStyle: React.CSSProperties = {
  fontFamily: font,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#6e6e73",
};

const sectionActionStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const sectionBodyStyle: React.CSSProperties = {
  border: "1px solid #e0e0e3",
  borderRadius: 8,
  overflow: "hidden",
  background: "#fff",
};

const errorRowStyle: React.CSSProperties = {
  padding: "8px 14px",
  background: "#fff4f3",
  color: "#b71c1c",
  fontFamily:
    '"SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
  borderTop: "1px solid #f0c4c0",
};
