import { useState } from 'react';
import { STATUS_CLASS, label } from '../lib/format.js';

export function Status({ value }) {
  return <span className={'pill ' + (STATUS_CLASS[value] || 'warn')}>{label(value)}</span>;
}

export function Msg({ error, ok }) {
  if (error) return <div className="error-banner">{error}</div>;
  if (ok) return <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>{ok}</div>;
  return null;
}

// Runs an async action, tracking busy state and surfacing failures as a message.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  async function run(fn, okMsg) {
    setBusy(true); setError(''); setOk('');
    try {
      const out = await fn();
      if (okMsg) setOk(okMsg);
      return out;
    } catch (e) {
      setError(e.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, ok, run, setError, setOk };
}

// Confirmation-with-comment control used for approve / return / reject style actions.
export function CommentAction({ actions, busy }) {
  const [comment, setComment] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input type="text" placeholder="Comment" value={comment} onChange={e => setComment(e.target.value)} style={{ flex: '1 1 220px', width: 'auto' }} />
      {actions.map(a => (
        <button key={a.label} className={a.primary ? 'primary' : 'ghost'} disabled={busy} onClick={() => a.onClick(comment).then?.(() => setComment(''))}>{a.label}</button>
      ))}
    </div>
  );
}

export function FySelect({ fy, setFy }) {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now - 1; y <= now + 4; y++) years.push(y);
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
      Plan cycle
      <select value={fy} onChange={e => setFy(Number(e.target.value))} style={{ width: 'auto' }}>
        {years.map(y => <option key={y} value={y}>{y} ({y}-{y + 2})</option>)}
      </select>
    </label>
  );
}
