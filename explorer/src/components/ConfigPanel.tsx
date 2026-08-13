import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { bin2hex } from 'scaffold.io/util/hex.ts';
import {
  addRandomKey,
  deleteKey,
  importKey,
  type KeyEntry,
  loadKeys,
  renameKey,
} from '../config/keyStore.ts';

export type GenVerifyMode = 'all' | 'none';

export interface SandboxConfig {
  selectedKeyId: string;
  strategies: Set<string>;
  enablePiggyback: boolean;
  enableLogging: boolean;
  useFloodGossip: boolean;
  enablePlugins: boolean;
  enableGenerationMode: GenVerifyMode;
  enableVerificationMode: GenVerifyMode;
}

export interface StrategyOption {
  key: string;
  label: string;
  description: string;
}

export interface ConfigPanelProps {
  open: boolean;
  current: SandboxConfig;
  strategyOptions: StrategyOption[];
  /** Optional headline shown at the top of the panel. */
  title?: string;
  /** Optional caveat shown below the identity section (e.g. seed-driven routes). */
  identityNote?: React.ReactNode;
  onClose: () => void;
  onApply: (next: SandboxConfig) => void;
}

export function ConfigPanel(props: ConfigPanelProps) {
  const {
    open,
    current,
    strategyOptions,
    title = 'Scaffold Configuration',
    identityNote,
    onClose,
    onApply,
  } = props;

  const [keys, setKeys] = useState<KeyEntry[]>(() => loadKeys());
  const [draft, setDraft] = useState<SandboxConfig>(current);
  const [importHex, setImportHex] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Reset draft whenever the panel reopens.
  useEffect(() => {
    if (open) {
      setDraft(current);
      setKeys(loadKeys());
      setImportHex('');
      setImportError(null);
      setRenameTarget(null);
    }
  }, [open, current]);

  const dirty = useMemo(() => !isEqual(draft, current), [draft, current]);

  const selectedKey = useMemo(
    () => keys.find((k) => k.id === draft.selectedKeyId) ?? keys[0],
    [keys, draft.selectedKeyId],
  );

  const updateDraft = useCallback((patch: Partial<SandboxConfig>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSelectKey = useCallback((id: string) => {
    updateDraft({ selectedKeyId: id });
  }, [updateDraft]);

  const handleGenerateKey = useCallback(() => {
    const { keys: nextKeys, newId } = addRandomKey(keys);
    setKeys(nextKeys);
    updateDraft({ selectedKeyId: newId });
  }, [keys, updateDraft]);

  const handleImportKey = useCallback(() => {
    setImportError(null);
    try {
      const { keys: nextKeys, newId } = importKey(keys, importHex);
      setKeys(nextKeys);
      updateDraft({ selectedKeyId: newId });
      setImportHex('');
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }, [keys, importHex, updateDraft]);

  const handleDeleteKey = useCallback((id: string) => {
    const nextKeys = deleteKey(keys, id);
    setKeys(nextKeys);
    if (draft.selectedKeyId === id) {
      const fallback = nextKeys[0];
      if (fallback) {
        updateDraft({ selectedKeyId: fallback.id });
      }
    }
  }, [keys, draft.selectedKeyId, updateDraft]);

  const handleStartRename = useCallback((entry: KeyEntry) => {
    setRenameTarget(entry.id);
    setRenameValue(entry.label);
  }, []);

  const handleCommitRename = useCallback(() => {
    if (!renameTarget) return;
    const nextKeys = renameKey(keys, renameTarget, renameValue);
    setKeys(nextKeys);
    setRenameTarget(null);
  }, [keys, renameTarget, renameValue]);

  const toggleStrategy = useCallback((key: string) => {
    setDraft((prev) => {
      const next = new Set(prev.strategies);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, strategies: next };
    });
  }, []);

  const handleApply = useCallback(() => {
    onApply(draft);
  }, [draft, onApply]);

  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={onClose}>
      <div
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
        role='dialog'
        aria-label={title}
      >
        <div style={headerStyle}>
          <span style={titleStyle}>{title}</span>
          <button onClick={onClose} style={iconBtnStyle} title='Close'>×</button>
        </div>

        <div style={bodyStyle}>
          <Section label='Identity (private key)'>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {keys.map((k) => (
                <KeyRow
                  key={k.id}
                  entry={k}
                  selected={draft.selectedKeyId === k.id}
                  renaming={renameTarget === k.id}
                  renameValue={renameValue}
                  onSelect={() => handleSelectKey(k.id)}
                  onStartRename={() => handleStartRename(k)}
                  onChangeRename={setRenameValue}
                  onCommitRename={handleCommitRename}
                  onCancelRename={() => setRenameTarget(null)}
                  onDelete={() => handleDeleteKey(k.id)}
                />
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                gap: 8,
                marginTop: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <button onClick={handleGenerateKey} style={btnPrimary}>
                + Generate new key
              </button>
              <input
                value={importHex}
                onChange={(e) => setImportHex(e.target.value)}
                placeholder='Import private key (64 hex chars)'
                style={{ ...inputStyle, flex: 1, minWidth: 240 }}
              />
              <button
                onClick={handleImportKey}
                style={btnSecondary}
                disabled={importHex.trim().length === 0}
              >
                Import
              </button>
            </div>
            {importError && <div style={errorStyle}>{importError}</div>}
            {selectedKey && (
              <div style={{ marginTop: 10, fontSize: 11, color: '#6e6e73' }}>
                <div>
                  Public key: <Mono>{bin2hex(selectedKey.publicKey)}</Mono>
                </div>
                <div>
                  Key id (priv hash): <Mono>{selectedKey.id}</Mono>
                </div>
              </div>
            )}
            {identityNote && <div style={noteStyle}>{identityNote}</div>}
          </Section>

          {strategyOptions.length > 0 && (
            <Section label='Strategies'>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {strategyOptions.map((s) => (
                  <label key={s.key} style={checkRowStyle}>
                    <input
                      type='checkbox'
                      checked={draft.strategies.has(s.key)}
                      onChange={() => toggleStrategy(s.key)}
                      style={checkboxStyle}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>
                        {s.label}
                      </span>
                      <span style={{ fontSize: 11, color: '#8e8e93' }}>
                        {s.description}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            </Section>
          )}

          <Section label='Networking'>
            <ToggleRow
              label='Enable P2P transports (WebSocket + WebRTC)'
              description='Adds plugins for live peering. Off keeps the node local.'
              checked={draft.enablePlugins}
              onChange={(v) => updateDraft({ enablePlugins: v })}
            />
            <ToggleRow
              label='Use flood gossip (demo)'
              description='Floods every atom to all peers. Disable piggyback alongside this.'
              checked={draft.useFloodGossip}
              onChange={(v) => updateDraft({ useFloodGossip: v })}
            />
          </Section>

          <Section label='Behavior'>
            <ToggleRow
              label='Enable piggyback strategy'
              description='Default. Generates claims on registered verifiers.'
              checked={draft.enablePiggyback}
              onChange={(v) => updateDraft({ enablePiggyback: v })}
            />
            <ToggleRow
              label='Enable structured event logging'
              description='Powers the debug API exposed on window.__scaffold.'
              checked={draft.enableLogging}
              onChange={(v) => updateDraft({ enableLogging: v })}
            />
            <ChoiceRow
              label='Generation'
              description='Filter for which contracts run generation.'
              value={draft.enableGenerationMode}
              onChange={(v) => updateDraft({ enableGenerationMode: v })}
            />
            <ChoiceRow
              label='Verification'
              description='Filter for which contracts run verification.'
              value={draft.enableVerificationMode}
              onChange={(v) => updateDraft({ enableVerificationMode: v })}
            />
          </Section>
        </div>

        <div style={footerStyle}>
          <span style={{ fontSize: 12, color: '#8e8e93' }}>
            {dirty ? 'Pending changes -- restart to apply' : 'No changes'}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSecondary}>
              Cancel
            </button>
            <button
              onClick={handleApply}
              style={dirty ? btnPrimary : btnSecondaryDisabled}
              disabled={!dirty}
            >
              Apply &amp; Restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -- Subcomponents --------------------------------------------------------

function Section(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{props.label}</div>
      {props.children}
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={checkRowStyle}>
      <input
        type='checkbox'
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        style={checkboxStyle}
      />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{props.label}</span>
        <span style={{ fontSize: 11, color: '#8e8e93' }}>
          {props.description}
        </span>
      </div>
    </label>
  );
}

function ChoiceRow(props: {
  label: string;
  description: string;
  value: GenVerifyMode;
  onChange: (v: GenVerifyMode) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '6px 8px',
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{props.label}</div>
        <div style={{ fontSize: 11, color: '#8e8e93' }}>
          {props.description}
        </div>
      </div>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as GenVerifyMode)}
        style={selectStyle}
      >
        <option value='all'>All contracts</option>
        <option value='none'>No contracts</option>
      </select>
    </div>
  );
}

function KeyRow(props: {
  entry: KeyEntry;
  selected: boolean;
  renaming: boolean;
  renameValue: string;
  onSelect: () => void;
  onStartRename: () => void;
  onChangeRename: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const { entry, selected, renaming } = props;
  const rowSelectable = !renaming && !selected;
  return (
    <div
      role={rowSelectable ? 'button' : undefined}
      tabIndex={rowSelectable ? 0 : -1}
      onClick={rowSelectable ? props.onSelect : undefined}
      onKeyDown={rowSelectable
        ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onSelect();
          }
        }
        : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        border: selected ? '1px solid #0071e3' : '1px solid #d2d2d7',
        background: selected ? 'rgba(0,113,227,0.06)' : '#fff',
        cursor: rowSelectable ? 'pointer' : 'default',
      }}
    >
      <input
        type='radio'
        checked={selected}
        readOnly
        tabIndex={-1}
        style={{ accentColor: '#0071e3', pointerEvents: 'none' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {renaming
          ? (
            <input
              autoFocus
              value={props.renameValue}
              onChange={(e) => props.onChangeRename(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.onCommitRename();
                if (e.key === 'Escape') props.onCancelRename();
              }}
              onBlur={props.onCommitRename}
              style={{ ...inputStyle, width: '100%' }}
            />
          )
          : (
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {entry.label}
              </span>
              {entry.builtIn && <span style={badgeStyle}>built-in</span>}
              <Mono dim>{entry.id.slice(0, 12)}…</Mono>
            </div>
          )}
      </div>
      {!entry.builtIn && !renaming && (
        <>
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onStartRename();
            }}
            style={smallBtn}
            title='Rename'
          >
            Rename
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete();
            }}
            style={smallBtnDanger}
            title='Delete key'
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function Mono(props: { children: React.ReactNode; dim?: boolean }) {
  return (
    <code
      style={{
        fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
        fontSize: 11,
        color: props.dim ? '#8e8e93' : '#1d1d1f',
        wordBreak: 'break-all',
      }}
    >
      {props.children}
    </code>
  );
}

// -- Equality -------------------------------------------------------------

function isEqual(a: SandboxConfig, b: SandboxConfig): boolean {
  if (a.selectedKeyId !== b.selectedKeyId) return false;
  if (a.enablePiggyback !== b.enablePiggyback) return false;
  if (a.enableLogging !== b.enableLogging) return false;
  if (a.useFloodGossip !== b.useFloodGossip) return false;
  if (a.enablePlugins !== b.enablePlugins) return false;
  if (a.enableGenerationMode !== b.enableGenerationMode) return false;
  if (a.enableVerificationMode !== b.enableVerificationMode) return false;
  if (a.strategies.size !== b.strategies.size) return false;
  for (const k of a.strategies) if (!b.strategies.has(k)) return false;
  return true;
}

// -- Styles ---------------------------------------------------------------

const font = '-apple-system, BlinkMacSystemFont, sans-serif';

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.35)',
  zIndex: 2147483645,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: font,
};

const modalStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.97)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderRadius: 12,
  border: '1px solid #d2d2d7',
  boxShadow: '0 12px 40px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)',
  width: 640,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100vh - 64px)',
  display: 'flex',
  flexDirection: 'column',
  color: '#1d1d1f',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 16px',
  borderBottom: '1px solid #e5e5ea',
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
};

const iconBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  fontSize: 18,
  cursor: 'pointer',
  color: '#1d1d1f',
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '8px 0',
};

const sectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid #f0f0f5',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#8e8e93',
  marginBottom: 8,
};

const checkRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
  padding: '6px 8px',
  borderRadius: 8,
  cursor: 'pointer',
};

const checkboxStyle: React.CSSProperties = {
  accentColor: '#0071e3',
  width: 16,
  height: 16,
  marginTop: 2,
};

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #d2d2d7',
  borderRadius: 8,
  fontSize: 12,
  fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
  outline: 'none',
  background: '#fff',
};

const selectStyle: React.CSSProperties = {
  padding: '5px 26px 5px 10px',
  border: '1px solid #d2d2d7',
  borderRadius: 8,
  fontSize: 12,
  background: '#fff',
  fontFamily: font,
  outline: 'none',
};

const btnPrimary: React.CSSProperties = {
  padding: '6px 14px',
  background: '#0071e3',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: font,
};

const btnSecondary: React.CSSProperties = {
  ...btnPrimary,
  background: '#f5f5f7',
  color: '#1d1d1f',
  border: '1px solid #d2d2d7',
};

const btnSecondaryDisabled: React.CSSProperties = {
  ...btnSecondary,
  opacity: 0.5,
  cursor: 'not-allowed',
};

const smallBtn: React.CSSProperties = {
  padding: '3px 9px',
  background: '#f5f5f7',
  color: '#1d1d1f',
  border: '1px solid #d2d2d7',
  borderRadius: 6,
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: font,
};

const smallBtnDanger: React.CSSProperties = {
  ...smallBtn,
  color: '#d70015',
  borderColor: '#f5c2c2',
};

const badgeStyle: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  padding: '2px 6px',
  borderRadius: 4,
  background: '#e5e5ea',
  color: '#48484a',
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: '#d70015',
};

const noteStyle: React.CSSProperties = {
  marginTop: 10,
  padding: '8px 10px',
  borderRadius: 8,
  background: '#fff7d6',
  border: '1px solid #f3e3a8',
  color: '#5a4a00',
  fontSize: 11,
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderTop: '1px solid #e5e5ea',
  background: 'rgba(245,245,247,0.6)',
};
