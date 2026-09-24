import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from '../components/ui.jsx';
import { ROLE_LABEL } from '../lib/format.js';

const ROLES = Object.keys(ROLE_LABEL);
const blankUser = { name: '', email: '', role: 'requester', department_id: '', sub_unit_id: '', password: '' };

function Users() {
  const { lookups } = useApp();
  const [users, setUsers] = useState([]);
  const [f, setF] = useState(blankUser);
  const { busy, error, ok, run } = useAction();
  const load = useCallback(() => api.get('/users').then(setUsers), []);
  useEffect(() => { load(); }, [load]);
  const subsOf = id => lookups.subUnits.filter(s => s.department_id === Number(id) && s.active);

  async function create(e) {
    e.preventDefault();
    const out = await run(() => api.post('/users', f), 'User created.');
    if (out) { setF(blankUser); load(); }
  }
  const patch = async (u, body, msg) => { await run(() => api.put('/users/' + u.id, body), msg); load(); };

  return (
    <div className="card">
      <h2>Users</h2>
      <p className="hint">Each user belongs to a department and optionally to one of its sub units. A department user <b>with a sub unit</b> submits and sees only that sub unit's requests; one without sees the whole department. Department heads authorise requests for their department and all its sub units. The Board / CEO role is read-only.</p>
      <Msg error={error} ok={ok} />
      <form onSubmit={create} className="grid g4" style={{ alignItems: 'end' }}>
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field"><span>Email</span><input type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} required /></label>
        <label className="field"><span>Role</span><select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        <label className="field"><span>Department</span><select value={f.department_id} onChange={e => setF({ ...f, department_id: e.target.value, sub_unit_id: '' })} required><option value="">Select…</option>{lookups.departments.filter(d => d.active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="field"><span>Sub unit (optional)</span><select value={f.sub_unit_id} onChange={e => setF({ ...f, sub_unit_id: e.target.value })}><option value="">Department level</option>{subsOf(f.department_id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Initial password (min 8)</span><input type="password" minLength={8} value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required /></label>
        <div className="field"><button className="primary" disabled={busy}>Create user</button></div>
      </form>
      <div className="tbl-wrap" style={{ maxHeight: 420 }}><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Sub unit</th><th>Active</th><th></th></tr></thead>
        <tbody>{users.map(u => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
            <td><select value={u.role} onChange={e => patch(u, { role: e.target.value }, 'Role updated.')}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></td>
            <td><select value={u.department_id || ''} onChange={e => patch(u, { department_id: Number(e.target.value) }, 'Department updated.')}>{lookups.departments.map(d => <option key={d.id} value={d.id}>{d.name}{d.active ? '' : ' (inactive)'}</option>)}</select></td>
            <td><select value={u.sub_unit_id || ''} onChange={e => patch(u, { sub_unit_id: e.target.value }, 'Sub unit updated.')}><option value="">Department level</option>{subsOf(u.department_id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
            <td><input type="checkbox" checked={!!u.active} onChange={e => patch(u, { active: e.target.checked }, 'User updated.')} style={{ width: 16 }} /></td>
            <td><button className="mini plain" onClick={() => { const p = prompt(`New password for ${u.email} (min 8 characters):`); if (p) patch(u, { password: p }, 'Password reset.'); }}>reset password</button></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function Org() {
  const { lookups, reload } = useApp();
  const [div, setDiv] = useState('');
  const [dept, setDept] = useState({ code: '', name: '', division_id: '' });
  const [subName, setSubName] = useState({});
  const { busy, error, ok, run } = useAction();
  const go = async (fn, msg) => { const out = await run(fn, msg); await reload(); return out; };

  const merge = async d => {
    const into = window.prompt(`Move ALL users, requests and budget lines of "${d.name}" into which department? Enter its code (e.g. PRJ). ${d.name} will then be deactivated.\n\nAvailable: ${lookups.departments.filter(x => x.id !== d.id && x.active).map(x => x.code).join(', ')}`);
    if (!into) return;
    const target = lookups.departments.find(x => x.code.toLowerCase() === into.trim().toLowerCase() && x.id !== d.id);
    if (!target) { window.alert('No department with that code.'); return; }
    const out = await go(() => api.post(`/lookups/departments/${d.id}/merge`, { into_id: target.id }));
    if (out) window.alert(`Moved ${out.moved.users} user(s), ${out.moved.requests} request(s) and ${out.moved.budgets} budget line(s) into ${target.name}. Set each user's sub unit under Users if needed.`);
  };

  return (
    <div>
      <Msg error={error} ok={ok} />
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Add to the structure</h2>
        <p className="hint">Division → Department → Sub unit. Every sub unit can submit its own procurement requests.</p>
        <div className="grid g2">
          <form className="addrow" style={{ marginTop: 0 }} onSubmit={async e => { e.preventDefault(); await go(() => api.post('/lookups/divisions', { name: div }), 'Division added.'); setDiv(''); }}>
            <input type="text" placeholder="New division" value={div} onChange={e => setDiv(e.target.value)} required />
            <button className="primary" disabled={busy}>Add division</button>
          </form>
          <form className="addrow" style={{ marginTop: 0 }} onSubmit={async e => { e.preventDefault(); await go(() => api.post('/lookups/departments', dept), 'Department added.'); setDept({ code: '', name: '', division_id: '' }); }}>
            <input type="text" placeholder="Code" value={dept.code} onChange={e => setDept({ ...dept, code: e.target.value })} style={{ width: 80 }} required />
            <input type="text" placeholder="Department" value={dept.name} onChange={e => setDept({ ...dept, name: e.target.value })} required />
            <select value={dept.division_id} onChange={e => setDept({ ...dept, division_id: e.target.value })} required><option value="">Division…</option>{lookups.divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
            <button className="primary" disabled={busy}>Add department</button>
          </form>
        </div>
      </div>

      {[...lookups.divisions, { id: null, name: 'No division (legacy)', active: 1 }].map(v => {
        const depts = lookups.departments.filter(d => (d.division_id || null) === v.id);
        if (!depts.length) return null;
        return (
          <div className="card" key={v.id ?? 'none'} style={{ marginBottom: 14 }}>
            <h2>{v.name}</h2>
            <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
              <thead><tr><th>Code</th><th>Department</th><th>Sub units</th><th>Active</th><th></th></tr></thead>
              <tbody>{depts.map(d => (
                <tr key={d.id} style={d.active ? undefined : { opacity: 0.55 }}>
                  <td>{d.code}</td><td className="wrap">{d.name}</td>
                  <td className="wrap">
                    {lookups.subUnits.filter(s => s.department_id === d.id).map(s => (
                      <label key={s.id} className="chk" style={{ display: 'inline-flex', marginRight: 12, padding: '2px 0' }} title="Untick to retire this sub unit">
                        <input type="checkbox" checked={!!s.active} onChange={() => go(() => api.put('/lookups/sub-units/' + s.id, { active: !s.active }))} />{s.name}
                      </label>
                    ))}
                    <form style={{ display: 'inline-flex', gap: 4, marginLeft: 6 }} onSubmit={async e => { e.preventDefault(); if (!subName[d.id]) return; await go(() => api.post('/lookups/sub-units', { department_id: d.id, name: subName[d.id] }), 'Sub unit added.'); setSubName({ ...subName, [d.id]: '' }); }}>
                      <input type="text" placeholder="+ sub unit" value={subName[d.id] || ''} onChange={e => setSubName({ ...subName, [d.id]: e.target.value })} style={{ width: 110, padding: '4px 6px' }} />
                    </form>
                  </td>
                  <td><input type="checkbox" checked={!!d.active} onChange={() => go(() => api.put('/lookups/departments/' + d.id, { active: !d.active }))} style={{ width: 16 }} /></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <select value={d.division_id || ''} onChange={e => go(() => api.put('/lookups/departments/' + d.id, { division_id: Number(e.target.value) }))} style={{ width: 'auto', padding: '4px' }}>
                      <option value="" disabled>Division…</option>{lookups.divisions.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    <button className="mini plain" onClick={() => merge(d)} title="Move users, requests and budgets into another department">merge into…</button>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        );
      })}
    </div>
  );
}

function Categories() {
  const { lookups, reload } = useApp();
  const [cat, setCat] = useState({ name: '', manual_type: 'goods' });
  const { busy, error, ok, run } = useAction();
  const go = async (fn, msg) => { await run(fn, msg); reload(); };
  return (
    <div className="card">
      <h2>Categories</h2>
      <p className="hint">The manual type decides which Shopping limits and reporting group (Goods / Works / Non-consulting services) applies. The procurement unit can also add categories.</p>
      <Msg error={error} ok={ok} />
      <form className="addrow" onSubmit={async e => { e.preventDefault(); await go(() => api.post('/lookups/categories', cat), 'Category added.'); setCat({ name: '', manual_type: 'goods' }); }}>
        <input type="text" placeholder="Category name" value={cat.name} onChange={e => setCat({ ...cat, name: e.target.value })} required />
        <select value={cat.manual_type} onChange={e => setCat({ ...cat, manual_type: e.target.value })}><option value="goods">Goods</option><option value="works">Works</option><option value="services">Services</option></select>
        <button className="primary" disabled={busy}>Add</button>
      </form>
      <div className="tbl-wrap" style={{ maxHeight: 360 }}><table><tbody>
        {lookups.categories.map(c => <tr key={c.id}><td>{c.name}</td>
          <td><select value={c.manual_type} onChange={e => go(() => api.put('/lookups/categories/' + c.id, { manual_type: e.target.value }), 'Updated.')}>
            <option value="goods">Goods</option><option value="works">Works</option><option value="services">Services</option></select></td>
          <td><label className="chk" style={{ padding: 0 }}><input type="checkbox" checked={!!c.active} onChange={() => go(() => api.put('/lookups/categories/' + c.id, { active: !c.active }), 'Updated.')} /> active</label></td></tr>)}
      </tbody></table></div>
    </div>
  );
}

function Settings() {
  const { lookups, reload } = useApp();
  const [text, setText] = useState(JSON.stringify(lookups.limits, null, 2));
  const [org, setOrg] = useState(lookups.org.name || '');
  const [lead, setLead] = useState(lookups.reminders.lead_days);
  const { busy, error, ok, run } = useAction();

  return (
    <div className="grid g2">
      <div className="card">
        <h2>Authority limits (Section 2.9)</h2>
        <p className="hint">Committee limits (LKR Mn, incl. VAT, inclusive upper bound, <code>null</code> = unlimited) and Shopping caps. LECO own-funds and GOSL follow the "GOSL" table; Foreign and Grant follow the "Foreign" table. Defaults follow the 2024 Manual; change only when a circular amends them.</p>
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
      <div>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Execution reminders</h2>
          <p className="hint">Departments are reminded on their dashboard when an approved item's planned start date is within this many days (or already past) and no execution request has been sent.</p>
          <label className="field"><span>Reminder lead time (days)</span><input type="number" min="1" max="365" value={lead} onChange={e => setLead(e.target.value)} /></label>
          <button className="primary" disabled={busy} onClick={async () => { await run(() => api.put('/lookups/reminders', { lead_days: Number(lead) }), 'Reminder lead time saved.'); reload(); }}>Save</button>
        </div>
        <div className="card">
          <h2>Organisation</h2>
          <label className="field"><span>Name shown on reports</span><input type="text" value={org} onChange={e => setOrg(e.target.value)} /></label>
          <button className="primary" disabled={busy} onClick={async () => { await run(() => api.put('/lookups/org', { name: org }), 'Saved.'); reload(); }}>Save</button>
        </div>
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
        {[['users', 'Users'], ['org', 'Divisions, departments & sub units'], ['categories', 'Categories'], ['settings', 'Limits, reminders & organisation'], ['audit', 'Audit trail']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'org' && <Org />}
      {tab === 'categories' && <Categories />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
