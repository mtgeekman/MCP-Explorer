// JSON as the readable pane shows it: pretty or compact for the whole pane,
// colored by token up to HIGHLIGHT_LIMIT. In Pretty, a string that holds a
// JSON object or array is shown decoded, marked as such. The mode is a view
// preference, remembered per machine like the pane sizes.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { HIGHLIGHT_LIMIT, embeddedJson, formatJson, prettyTokens, tokenizeJson, type JsonMode, type Token } from '../lib/json';

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

export function useJsonMode(): JsonMode {
  return useContext(JsonModeContext).mode;
}

export function JsonModeToggle() {
  const { mode, setMode } = useContext(JsonModeContext);
  return (
    <span className="json-toggle" role="group" aria-label="JSON layout">
      <button aria-pressed={mode === 'pretty'} onClick={() => setMode('pretty')} title="Indented and colored; JSON inside a string is shown decoded">Pretty</button>
      <button aria-pressed={mode === 'compact'} onClick={() => setMode('compact')} title="One line, every string as it is">Compact</button>
    </span>
  );
}

type Parsed = { ok: true; value: unknown } | { ok: false };

/**
 * One JSON block. Give it a parsed `value`, or `text` that is already JSON;
 * text that does not parse is shown as it is. `mode` overrides the pane's,
 * for a block with a switch of its own (a surface entry's Definition).
 */
export function JsonView(props: ({ value: unknown } | { text: string }) & { mode?: JsonMode }) {
  const paneMode = useJsonMode();
  const mode = props.mode ?? paneMode;
  const isText = 'text' in props;
  const input = isText ? props.text : props.value;
  const parsed = useMemo<Parsed>(() => {
    if (!isText) return { ok: true, value: input };
    try {
      return { ok: true, value: JSON.parse(input as string) };
    } catch {
      return { ok: false };
    }
  }, [isText, input]);
  const text = useMemo(() => (parsed.ok ? formatJson(parsed.value, mode) : (input as string)), [parsed, mode, input]);
  const tokens = useMemo(() => {
    if (!parsed.ok || text.length > HIGHLIGHT_LIMIT) return null;
    return mode === 'pretty' ? prettyTokens(parsed.value, { embedded: true }) : tokenizeJson(text);
  }, [parsed, mode, text]);
  return (
    <>
      {parsed.ok && !tokens && <p className="muted">Shown without color: it is larger than {HIGHLIGHT_LIMIT / 1024} KB.</p>}
      <pre className={`mono json json-view ${mode}`}>{tokens ? render(tokens) : text}</pre>
    </>
  );
}

/**
 * A text content part: shown as text, or, in Pretty, as formatted JSON when
 * the whole text is a JSON object or array, marked as decoded.
 */
export function TextPart({ text }: { text: string }) {
  const mode = useJsonMode();
  const inner = useMemo(() => (mode === 'pretty' ? embeddedJson(text) : undefined), [mode, text]);
  if (inner === undefined) return <pre className="mono part-text">{text}</pre>;
  return (
    <div className="json-embed json-embed-part">
      <span className="json-badge" aria-label="Text content that is JSON, shown decoded">JSON in the text</span>
      <JsonView value={inner} />
    </div>
  );
}

/** Tokens to elements: a decoded string becomes a nested block with its badge. */
function render(tokens: Token[]): ReactNode[] {
  const root: ReactNode[] = [];
  const stack: ReactNode[][] = [root];
  tokens.forEach((t, i) => {
    const top = stack[stack.length - 1];
    if (t.kind === 'embed-open') {
      const children: ReactNode[] = [];
      top.push(<span key={i} className="json-embed">{children}</span>);
      stack.push(children);
    } else if (t.kind === 'embed-close') {
      stack.pop();
    } else if (t.kind === 'badge') {
      top.push(<span key={i} className="json-badge" aria-label={`${t.text}, shown decoded`}>{t.text}</span>);
    } else if (t.kind === 'space' || t.kind === 'other') {
      top.push(t.text);
    } else {
      top.push(<span key={i} className={`j-${t.kind}`}>{t.text}</span>);
    }
  });
  return root;
}
