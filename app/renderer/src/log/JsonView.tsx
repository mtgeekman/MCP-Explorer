// JSON as the readable pane shows it: pretty or compact for the whole pane,
// colored by token up to HIGHLIGHT_LIMIT. The mode is a view preference,
// remembered per machine like the pane sizes.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { HIGHLIGHT_LIMIT, formatJson, reformatJson, tokenizeJson, type JsonMode } from '../lib/json';

const KEY = 'mcpx.jsonMode';

function stored(): JsonMode {
  try {
    return window.localStorage.getItem(KEY) === 'compact' ? 'compact' : 'pretty';
  } catch {
    return 'pretty';
  }
}

const JsonModeContext = createContext<{ mode: JsonMode; setMode: (m: JsonMode) => void }>({ mode: 'pretty', setMode: () => undefined });

/** Holds the pane's mode; each readable surface (the pane, the popped-out window) has one. */
export function JsonModeProvider({ children }: { children: ReactNode }) {
  const [mode, set] = useState<JsonMode>(stored);
  const setMode = (m: JsonMode) => {
    set(m);
    try {
      window.localStorage.setItem(KEY, m);
    } catch {
      // The mode still applies for this session; only its memory is lost.
    }
  };
  return <JsonModeContext.Provider value={{ mode, setMode }}>{children}</JsonModeContext.Provider>;
}

export function JsonModeToggle() {
  const { mode, setMode } = useContext(JsonModeContext);
  return (
    <span className="json-toggle" role="group" aria-label="JSON layout">
      <button aria-pressed={mode === 'pretty'} onClick={() => setMode('pretty')}>Pretty</button>
      <button aria-pressed={mode === 'compact'} onClick={() => setMode('compact')}>Compact</button>
    </span>
  );
}

/**
 * One JSON block. Give it a parsed `value`, or `text` that is already JSON;
 * text that does not parse is shown as it is.
 */
export function JsonView(props: { value: unknown } | { text: string }) {
  const { mode } = useContext(JsonModeContext);
  const isText = 'text' in props;
  const input = isText ? props.text : props.value;
  const text = useMemo(() => (isText ? reformatJson(input as string, mode) : formatJson(input, mode)), [isText, input, mode]);
  const tokens = useMemo(() => (text.length <= HIGHLIGHT_LIMIT ? tokenizeJson(text) : null), [text]);
  return (
    <>
      {!tokens && <p className="muted">Shown without color: it is larger than {HIGHLIGHT_LIMIT / 1024} KB.</p>}
      <pre className={`mono json json-view ${mode}`}>
        {tokens ? tokens.map((t, i) => (t.kind === 'space' || t.kind === 'other' ? t.text : <span key={i} className={`j-${t.kind}`}>{t.text}</span>)) : text}
      </pre>
    </>
  );
}
