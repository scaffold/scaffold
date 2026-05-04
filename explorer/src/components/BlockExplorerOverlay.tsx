import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HighlightRegistry } from "../highlight/HighlightRegistry.ts";
import { HighlightContext } from "../highlight/HighlightContext.ts";
import { BlockGraph } from "./BlockGraph.tsx";
import { BlockCreationModal } from "./BlockCreationModal.tsx";
import type {
  InitialClaim,
  YamlEditorProps,
} from "./BlockCreationModal.tsx";
import type { Scaffold } from "scaffold.io/Scaffold.ts";

export type OverlayMode = "hidden" | "panel" | "fullscreen";

export interface BlockExplorerOverlayProps {
  scaffold: Scaffold;
  /** Initial visibility. Default "hidden" (pill only). */
  defaultMode?: OverlayMode;
  /** Edge to dock the slide-in panel. Default "right". */
  position?: "right" | "left";
  /** Override the pill label. Default "Explorer". */
  pillLabel?: string;
  /** Optional JSX shown in the panel header — demo-specific controls. */
  actions?: React.ReactNode;
  /** Hide the close affordance (used for standalone full-screen mode). */
  dismissable?: boolean;
  /** Optional YAML editor + parser for the bundled "Create Block" modal. */
  parseYaml?: (text: string) => Record<string, unknown> | null;
  renderYamlEditor?: (props: YamlEditorProps) => React.ReactElement;
}

const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 1200;
const DEFAULT_PANEL_WIDTH = 560;
const STORAGE_KEY = "scaffold-explorer-panel-width";

function loadStoredWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PANEL_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_PANEL_WIDTH;
    return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, n));
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function persistWidth(width: number) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(width));
  } catch {
    // noop -- storage unavailable
  }
}

export function BlockExplorerOverlay(props: BlockExplorerOverlayProps) {
  const {
    scaffold,
    defaultMode = "hidden",
    position = "right",
    pillLabel = "Explorer",
    actions,
    dismissable = true,
    parseYaml,
    renderYamlEditor,
  } = props;

  const [mode, setMode] = useState<OverlayMode>(defaultMode);
  const [panelWidth, setPanelWidth] = useState<number>(() => loadStoredWidth());
  const [blockCount, setBlockCount] = useState<number>(() => {
    let n = 0;
    for (const _ of scaffold.blocks.getAll()) n++;
    return n;
  });
  const [pulse, setPulse] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [initialClaims, setInitialClaims] = useState<
    InitialClaim[] | undefined
  >();

  const registry = useMemo(() => new HighlightRegistry(), []);
  const pulseTimeoutRef = useRef<number | null>(null);

  // Live block count + pulse on new arrivals.
  useEffect(() => {
    const onAdd = () => {
      setBlockCount((c) => c + 1);
      setPulse(true);
      if (pulseTimeoutRef.current) {
        globalThis.clearTimeout(pulseTimeoutRef.current);
      }
      pulseTimeoutRef.current = globalThis.setTimeout(
        () => setPulse(false),
        700,
      ) as unknown as number;
    };
    scaffold.blocks.onAdd(onAdd);
    return () => {
      scaffold.blocks.offAdd(onAdd);
      if (pulseTimeoutRef.current) {
        globalThis.clearTimeout(pulseTimeoutRef.current);
        pulseTimeoutRef.current = null;
      }
    };
  }, [scaffold]);

  // Keyboard: backtick toggles, ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const isTextual = t && (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.isContentEditable
      );
      if (e.key === "`" && !isTextual && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setMode((m) => (m === "hidden" ? "panel" : "hidden"));
        return;
      }
      if (e.key === "Escape" && dismissable) {
        if (showCreateModal) return; // let the modal own ESC
        setMode((m) => (m === "hidden" ? m : "hidden"));
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [dismissable, showCreateModal]);

  // Drag-to-resize the side panel.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "panel") return;
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: panelWidth };

      const onMove = (ev: MouseEvent) => {
        const start = dragRef.current;
        if (!start) return;
        const dx = position === "right"
          ? start.startX - ev.clientX
          : ev.clientX - start.startX;
        const next = Math.min(
          PANEL_MAX_WIDTH,
          Math.max(PANEL_MIN_WIDTH, start.startWidth + dx),
        );
        setPanelWidth(next);
      };
      const onUp = () => {
        const start = dragRef.current;
        dragRef.current = null;
        globalThis.removeEventListener("mousemove", onMove);
        globalThis.removeEventListener("mouseup", onUp);
        if (start) persistWidth(panelWidth);
      };
      globalThis.addEventListener("mousemove", onMove);
      globalThis.addEventListener("mouseup", onUp);
    },
    [mode, panelWidth, position],
  );

  // Persist width whenever it settles.
  useEffect(() => {
    if (dragRef.current) return;
    persistWidth(panelWidth);
  }, [panelWidth]);

  const handleOpenCreate = useCallback((claims?: InitialClaim[]) => {
    setInitialClaims(claims);
    setShowCreateModal(true);
  }, []);

  const handleCloseCreate = useCallback(() => {
    setShowCreateModal(false);
    setInitialClaims(undefined);
  }, []);

  // Render -----------------------------------------------------------------

  if (mode === "hidden") {
    return (
      <button
        type="button"
        className={`explorer-overlay-pill explorer-overlay-pill-${position}${
          pulse ? " explorer-overlay-pill-pulse" : ""
        }`}
        onClick={() => setMode("panel")}
        title="Open Block Explorer (`)"
      >
        <span className="explorer-overlay-pill-icon" aria-hidden>◧</span>
        <span className="explorer-overlay-pill-label">{pillLabel}</span>
        <span className="explorer-overlay-pill-count">{blockCount}</span>
      </button>
    );
  }

  const panelStyle: React.CSSProperties = mode === "panel"
    ? { width: panelWidth }
    : {};

  return (
    <>
      {mode === "fullscreen" && (
        <div
          className="explorer-overlay-backdrop"
          onClick={dismissable ? () => setMode("hidden") : undefined}
        />
      )}
      <div
        className={[
          "explorer-overlay-panel",
          `explorer-overlay-panel-${mode}`,
          `explorer-overlay-panel-${position}`,
        ].join(" ")}
        style={panelStyle}
        role="dialog"
        aria-label="Block Explorer"
      >
        {mode === "panel" && (
          <div
            className={`explorer-overlay-resize explorer-overlay-resize-${position}`}
            onMouseDown={onResizeStart}
            title="Drag to resize"
          />
        )}
        <div className="explorer-overlay-header">
          <div className="explorer-overlay-header-title">
            <span className="explorer-overlay-header-icon" aria-hidden>◧</span>
            <span>Block Explorer</span>
            <span className="explorer-overlay-header-count">
              {blockCount} block{blockCount === 1 ? "" : "s"}
            </span>
          </div>
          {(actions || (parseYaml && renderYamlEditor)) && (
            <div className="explorer-overlay-header-actions">
              {actions}
              {parseYaml && renderYamlEditor && (
                <button
                  type="button"
                  className="explorer-overlay-create-btn"
                  onClick={() => handleOpenCreate()}
                  title="Author a new block manually"
                >
                  + Create Block
                </button>
              )}
            </div>
          )}
          <div className="explorer-overlay-header-buttons">
            <button
              type="button"
              className="explorer-overlay-iconbtn"
              onClick={() =>
                setMode((m) => (m === "fullscreen" ? "panel" : "fullscreen"))}
              title={mode === "fullscreen" ? "Collapse to side panel" : "Expand"}
            >
              {mode === "fullscreen" ? "⤡" : "⤢"}
            </button>
            {dismissable && (
              <button
                type="button"
                className="explorer-overlay-iconbtn"
                onClick={() => setMode("hidden")}
                title="Close (Esc)"
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="explorer-overlay-body">
          <HighlightContext.Provider value={registry}>
            <BlockGraph
              scaffold={scaffold}
              onCreateBlock={parseYaml && renderYamlEditor
                ? handleOpenCreate
                : undefined}
            />
          </HighlightContext.Provider>
        </div>
      </div>

      {showCreateModal && parseYaml && renderYamlEditor && (
        <BlockCreationModal
          scaffold={scaffold}
          initialClaims={initialClaims}
          onClose={handleCloseCreate}
          parseYaml={parseYaml}
          renderYamlEditor={renderYamlEditor}
        />
      )}
    </>
  );
}
