import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api.js';

export default function LoginPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/auth/setup-needed').then(d => setSetupNeeded(d.setupNeeded)).catch(() => {}); }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      if (setupNeeded) await register(name, email, password); else await login(email, password);
      nav('/app/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authwrap">
      <div className="brand" style={{ marginBottom: 24, justifyContent: 'center' }}>
        <div className="mark"></div>
        <h1 style={{ fontSize: 18 }}>LECO Procurement Planning</h1>
      </div>
      <div className="card">
        <h2>{setupNeeded ? 'Create the administrator account' : 'Sign in'}</h2>
        {setupNeeded && <p className="hint">No users exist yet. The first account becomes the administrator, who then creates departments' users.</p>}
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={onSubmit}>
          {setupNeeded && (
            <label className="field"><span>Full name</span>
              <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus />
            </label>
          )}
          <label className="field"><span>Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus={!setupNeeded} />
          </label>
          <label className="field"><span>Password{setupNeeded ? ' (min 8 characters)' : ''}</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={setupNeeded ? 8 : undefined} />
          </label>
          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Please wait…' : setupNeeded ? 'Create administrator' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
