import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from '../components/ui.jsx';
import { ROLE_LABEL } from '../lib/format.js';

const ROLES = Object.keys(ROLE_LABEL);

function Users() {
  const { lookups } = useApp();
  const [users, setUsers] = useState([]);
  const [f, setF] = useState({ name: '', email: '', role: 'requester', department_id: '', password: '' });
  const { busy, error, ok, run } = useAction();
  const load = useCallback(() => api.get('/users').then(setUsers), []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    const out = await run(() => api.post('/users', f), 'User created.');
    if (out) { setF({ name: '', email: '', role: 'requester', department_id: '', password: '' }); load(); }
  }
  const patch = async (u, body, msg) => { await run(() => api.put('/users/' + u.id, body), msg); load(); };

  return (
    <div className="card">
      <h2>Users</h2>
      <p className="hint">Each user belongs to one department. Department heads authorise requests for their department; the procurement unit assigns methods; management approves plans and revisions.</p>
      <Msg error={error} ok={ok} />
      <form onSubmit={create} className="grid g4" style={{ alignItems: 'end' }}>
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field"><span>Email</span><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></label>
        <label className="field"><span>Role</span><select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        <label className="field"><span>Department</span><select value={f.department_id} onChange={e => setF({ ...f, department_id: e.target.value })} required><option value="">Select…</option>{lookups.departments.filter(d => d.active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="field"><span>Initial password (min 8)</span><input type="password" minLength={8} value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required /></label>
        <div className="field"><button className="primary" disabled={busy}>Create user</button></div>
      </form>
      <div className="tbl-wrap" style={{ maxHeight: 360 }}><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Active</th><th></th></tr></thead>
        <tbody>{users.map(u => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
            <td><select value={u.role} onChange={e => patch(u, { role: e.target.value }, 'Role updated.')}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></td>
            <td><select value={u.department_id || ''} onChange={e => patch(u, { department_id: Number(e.target.value) }, 'Department updated.')}>{lookups.departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
            <td><input type="checkbox" checked={!!u.active} onChange={e => patch(u, { active: e.target.checked }, 'User updated.')} style={{ width: 16 }} /></td>
            <td><button className="mini plain" onClick={() => { const p = prompt(`New password for ${u.email} (min 8 characters):`); if (p) patch(u, { password: p }, 'Password reset.'); }}>reset password</button></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function Lists() {
  const { lookups, reload } = useApp();
  const [dept, setDept] = useState({ code: '', name: '' });
  const [cat, setCat] = useState({ name: '', manual_type: 'goods' });
  const { busy, error, ok, run } = useAction();
  const go = (fn, msg) => async () => { await run(fn, msg); reload(); };

  return (
    <div className="grid g2">
      <div className="card">
        <h2>Departments</h2>
        <Msg error={error} ok={ok} />
        <form className="addrow" onSubmit={async e => { e.preventDefault(); await go(() => api.post('/lookups/departments', dept), 'Department added.')(); setDept({ code: '', name: '' }); }}>
          <input type="text" placeholder="Code" value={dept.code} onChange={e => setDept({ ...dept, code: e.target.value })} style={{ width: 90 }} required />
          <input type="text" placeholder="Department name" value={dept.name} onChange={e => setDept({ ...dept, name: e.target.value })} required />
          <button className="primary" disabled={busy}>Add</button>
        </form>
        <div className="tbl-wrap" style={{ maxHeight: 280 }}><table><tbody>
          {lookups.departments.map(d => <tr key={d.id}><td>{d.code}</td><td className="wrap">{d.name}</td>
            <td><label className="chk" style={{ padding: 0 }}><input type="checkbox" checked={!!d.active} onChange={go(() => api.put('/lookups/departments/' + d.id, { active: !d.active }), 'Updated.')} /> active</label></td></tr>)}
        </tbody></table></div>
      </div>
      <div className="card">
        <h2>Categories</h2>
        <p className="hint">The manual type decides which Shopping limits and reporting group (Goods / Works / Non-consulting services) applies.</p>
        <form className="addrow" onSubmit={async e => { e.preventDefault(); await go(() => api.post('/lookups/categories', cat), 'Category added.')(); setCat({ name: '', manual_type: 'goods' }); }}>
          <input type="text" placeholder="Category name" value={cat.name} onChange={e => setCat({ ...cat, name: e.target.value })} required />
          <select value={cat.manual_type} onChange={e => setCat({ ...cat, manual_type: e.target.value })}><option value="goods">Goods</option><option value="works">Works</option><option value="services">Services</option></select>
          <button className="primary" disabled={busy}>Add</button>
        </form>
        <div className="tbl-wrap" style={{ maxHeight: 280 }}><table><tbody>
          {lookups.categories.map(c => <tr key={c.id}><td>{c.name}</td>
            <td><select value={c.manual_type} onChange={e => go(() => api.put('/lookups/categories/' + c.id, { manual_type: e.target.value }), 'Updated.')()}>
              <option value="goods">Goods</option><option value="works">Works</option><option value="services">Services</option></select></td>
            <td><label className="chk" style={{ padding: 0 }}><input type="checkbox" checked={!!c.active} onChange={go(() => api.put('/lookups/categories/' + c.id, { active: !c.active }), 'Updated.')} /> active</label></td></tr>)}
        </tbody></table></div>
      </div>
    </div>
  );
}

function Limits() {
  const { lookups, reload } = useApp();
  const [text, setText] = useState(JSON.stringify(lookups.limits, null, 2));
  const [org, setOrg] = useState(lookups.org.name || '');
  const { busy, error, ok, run } = useAction();

  return (
    <div className="grid g2">
      <div className="card">
        <h2>Authority limits (Section 2.9)</h2>
        <p className="hint">Committee limits (LKR Mn, incl. VAT, inclusive upper bound, <code>null</code> = unlimited) and Shopping caps. Defaults follow the 2024 Manual; change only when a circular amends them.</p>
        <Msg error={error} ok={ok} />
        <textarea rows={16} value={text} onChange={e => setText(e.target.value)} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="primary" disabled={busy} onClick={async () => {
            let parsed;
            try { parsed = JSON.parse(text); } catch (e) { alert('That is not valid JSON.'); return; }
            await run(() => api.put('/lookups/limits', parsed), 'Limits saved.'); reload();
          }}>Save limits</button>
          <button className="ghost" disabled={busy} onClick={async () => { if (confirm('Reset to the Manual defaults?')) { await run(() => api.del('/lookups/limits'), 'Reset to defaults.'); await reload(); setText(JSON.stringify(lookups.defaultLimits, null, 2)); } }}>Reset to defaults</button>
        </div>
      </div>
      <div className="card">
        <h2>Organisation</h2>
        <label className="field"><span>Name shown on reports</span><input type="text" value={org} onChange={e => setOrg(e.target.value)} /></label>
        <button className="primary" disabled={busy} onClick={async () => { await run(() => api.put('/lookups/org', { name: org }), 'Saved.'); reload(); }}>Save</button>
      </div>
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/lookups/audit').then(setRows).catch(() => {}); }, []);
  return (
    <div className="card">
      <h2>Audit trail</h2>
      <p className="hint">Latest 300 status changes and edits across the system.</p>
      <div className="tbl-wrap"><table>
        <thead><tr><th>When</th><th>Entity</th><th>Action</th><th>By</th><th>Comment</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}><td>{r.at.slice(0, 16).replace('T', ' ')}</td><td>{r.entity} {r.entity_id}</td><td>{r.action}</td><td>{r.user}</td><td className="wrap">{r.comment}</td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

export default function AdminPage() {
  const [tab, setTab] = useState('users');
  return (
    <div>
      <div className="tabbar">
        {[['users', 'Users'], ['lists', 'Departments & categories'], ['limits', 'Limits & organisation'], ['audit', 'Audit trail']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'lists' && <Lists />}
      {tab === 'limits' && <Limits />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
