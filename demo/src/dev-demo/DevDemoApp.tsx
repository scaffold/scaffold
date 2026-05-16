import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BlockExplorerOverlay,
  findKey,
  getOrCreateDefaultKeyId,
  type KeyEntry,
  loadKeys,
} from "@scaffold/explorer";
import { Scaffold, type ScaffoldConfig } from "scaffold.io/Scaffold.ts";
import { getGenesisBlock } from "scaffold.io/genesis.ts";
import { installDebugAPI } from "scaffold.io/debug/ScaffoldDebug.ts";
import type { Hash } from "scaffold.io/util/Hash.ts";
import { registerDevDemoGrammars } from "./languageGrammars.ts";
import { LanguageTabs } from "./LanguageTabs.tsx";
import { LanguagePanel } from "./LanguagePanel.tsx";
import {
  buildCompilerHashes,
  type CompilerHashes,
  publishEchoContract,
} from "./compilerHashes.ts";
import { DemoNav, type DemoRoute } from "./DemoNav.tsx";
import { type Lang, LANGUAGES } from "./examples/index.ts";
import { isFixtureMode } from "./fixtureMode.ts";

interface DevDemoAppProps {
  navigate: (route: DemoRoute) => void;
  initialLang: Lang;
  setLangInUrl: (lang: Lang) => void;
}

function pickInitialLang(candidate: string | null): Lang {
  if (!candidate) return "assemblyscript";
  const match = LANGUAGES.find((l) => l.id === candidate);
  return match ? match.id : "assemblyscript";
}

export { pickInitialLang };

export function DevDemoApp(
  { navigate, initialLang, setLangInUrl }: DevDemoAppProps,
) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [compilerHashes, setCompilerHashes] = useState<CompilerHashes | null>(
    null,
  );
  const [bootError, setBootError] = useState<string | null>(null);

  // Side-effect: register Monaco grammars exactly once before any editor mounts.
  useEffect(() => {
    registerDevDemoGrammars();
  }, []);

  const scaffold = useMemo(() => {
    const keys: KeyEntry[] = loadKeys();
    const keyEntry = findKey(keys, getOrCreateDefaultKeyId()) ?? keys[0];
    const config: ScaffoldConfig = {
      privateKey: keyEntry.privateKey,
      genesis: getGenesisBlock(),
      enableLogging: true,
      enablePiggyback: true,
      useFloodGossip: false,
    };
    const s = new Scaffold(config);
    installDebugAPI(s);
    return s;
  }, []);

  // Publish the C0 echo `.wasm` as a contract block on this Scaffold and use
  // its hash as the placeholder compiler hash for every language. Replaced
  // once real per-language compiler contracts ship (Workstream C).
  useEffect(() => {
    let cancelled = false;
    const fixture = isFixtureMode();
    publishEchoContract(scaffold)
      .then((hash) => {
        if (cancelled) return;
        scaffold.eventLog?.append(
          "dev-demo",
          "echo_published",
          { hash: hash.toHex(), fixture },
          "info",
        );
        setCompilerHashes(buildCompilerHashes(hash));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        scaffold.eventLog?.append(
          "dev-demo",
          "echo_publish_failed",
          { message },
          "warn",
        );
        setBootError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [scaffold]);

  const handleLangChange = useCallback(
    (next: Lang) => {
      setLang(next);
      setLangInUrl(next);
    },
    [setLangInUrl],
  );

  const handleHashClick = useCallback((hash: Hash) => {
    // Workstream D1 will add `initialFocusedHash` to BlockExplorerOverlay so
    // a click pre-focuses the graph on this block. Until then, surface the
    // hash through the event log so users can find it via __scaffold.
    scaffold.eventLog?.append(
      "dev-demo",
      "hash_clicked",
      { hash: hash.toHex() },
      "info",
    );
  }, [scaffold]);

  const compilerHash = compilerHashes ? compilerHashes[lang] : null;

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
      <div style={toolbarStyle}>
        <span style={logoStyle}>Scaffold</span>
        <span style={dividerStyle} />
        <DemoNav route="dev-demo" navigate={navigate} />
        <span style={{ ...hintStyle, marginLeft: 8 }}>
          Dev demo -- pick a language, write code, compile, invoke.
        </span>
      </div>

      <LanguageTabs current={lang} onChange={handleLangChange} />

      {bootError && (
        <div style={bootErrorStyle}>
          Failed to publish placeholder compiler contract: {bootError}
        </div>
      )}

      <LanguagePanel
        key={lang}
        scaffold={scaffold}
        lang={lang}
        compilerHash={compilerHash}
        onHashClick={handleHashClick}
      />

      <BlockExplorerOverlay scaffold={scaffold} />
    </div>
  );
}

const font = "-apple-system, BlinkMacSystemFont, sans-serif";

const toolbarStyle: React.CSSProperties = {
  padding: "10px 24px",
  background: "rgba(255, 255, 255, 0.72)",
  backdropFilter: "saturate(180%) blur(20px)",
  WebkitBackdropFilter: "saturate(180%) blur(20px)",
  borderBottom: "1px solid rgba(0, 0, 0, 0.1)",
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
  position: "sticky",
  top: 0,
  zIndex: 50,
};

const logoStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: "#1d1d1f",
  fontFamily: font,
  letterSpacing: "-0.02em",
};

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 20,
  background: "#d2d2d7",
  margin: "0 4px",
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#8e8e93",
  fontFamily: font,
};

const bootErrorStyle: React.CSSProperties = {
  padding: "10px 24px",
  background: "#fff4f3",
  color: "#b71c1c",
  fontFamily: font,
  fontSize: 12,
  borderBottom: "1px solid #f0c4c0",
};
