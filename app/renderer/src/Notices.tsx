// One line per notice, never silent (D28: every keychain repair is shown).
import type { WorkspaceNotice } from '../../../packages/backend/dist/index.js';

export function noticeText(n: WorkspaceNotice): string {
  switch (n.kind) {
    case 'keychain-restored':
      return `The keychain entry for ${n.name} was missing and has been restored.`;
    case 'keychain-restore-failed':
      return `The keychain entry for ${n.name} is missing and could not be restored (${n.message}). Keep its recovery key: it is what opens this workspace now.`;
  }
}

export function Notices({ notices, onDismiss }: { notices: WorkspaceNotice[]; onDismiss: (index: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className="notices">
      {notices.map((n, i) => (
        <div key={i} className={`notice ${n.kind === 'keychain-restore-failed' ? 'bad' : ''}`}>
          <span>{noticeText(n)}</span>
          <button onClick={() => onDismiss(i)}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}
