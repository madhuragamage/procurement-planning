import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import { Msg, useAction } from '../components/ui.jsx';
import { ROLE_LABEL, MAIN_CATEGORY_LABEL, EXPENSE_LABEL } from '../lib/format.js';

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
      <p className="hint">Each user belongs to a department and optionally to one of its sub units. A department user <b>with a sub unit</b> submits and sees only that sub unit's requests; one without sees the whole department. Department heads authorise requests for their department and all its sub units. The Board / CEO role is read-only. <b>Supplies Unit</b> users handle the procurement files forwarded after award; the head of the Supplies department (set under Limits, reminders &amp; organisation) can view their work.</p>
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
      <h2>Procurement categories</h2>
      <p className="hint">Main procurement category → sub category. The main category also decides the Shopping limits and reporting group (consultancy services use the services limits). The procurement unit can also add sub categories.</p>
      <Msg error={error} ok={ok} />
      <form className="addrow" onSubmit={async e => { e.preventDefault(); await go(() => api.post('/lookups/categories', cat), 'Sub category added.'); setCat({ ...cat, name: '' }); }}>
        <select value={cat.manual_type} onChange={e => setCat({ ...cat, manual_type: e.target.value })}>{lookups.mainCategories.map(m => <option key={m} value={m}>{MAIN_CATEGORY_LABEL[m]}</option>)}</select>
        <input type="text" placeholder="New sub category" value={cat.name} onChange={e => setCat({ ...cat, name: e.target.value })} required />
        <button className="primary" disabled={busy}>Add</button>
      </form>
      {lookups.mainCategories.map((m, n) => (
        <div key={m}>
          <div className="section-title">{n + 1}. {MAIN_CATEGORY_LABEL[m]}</div>
          <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table><tbody>
            {lookups.categories.filter(c => c.manual_type === m).map(c => <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}><td>{c.name}</td>
              <td><label className="chk" style={{ padding: 0 }}><input type="checkbox" checked={!!c.active} onChange={() => go(() => api.put('/lookups/categories/' + c.id, { active: !c.active }), 'Updated.')} /> active</label></td></tr>)}
          </tbody></table></div>
        </div>
      ))}
    </div>
  );
}

// Budget codes under each Budget Category; users pick one on the request.
function BudgetCodes() {
  const { lookups, reload } = useApp();
  const [f, setF] = useState({ expense_type: 'CAPEX', code: '', description: '' });
  const [edit, setEdit] = useState({});
  const { busy, error, ok, run } = useAction();
  const go = async (fn, msg) => { const out = await run(fn, msg); await reload(); return out; };
  return (
    <div className="card">
      <h2>Budget codes</h2>
      <p className="hint">Each code belongs to a Budget Category (CAPEX, OPEX or Inventory). On a request, the user picks the Budget Category and then one of its codes; once a category has codes, choosing one is required. Retire a code by unticking "active".</p>
      <Msg error={error} ok={ok} />
      <form className="addrow" onSubmit={async e => { e.preventDefault(); if (await go(() => api.post('/lookups/budget-codes', f), `Budget code ${f.code} added.`)) setF({ ...f, code: '', description: '' }); }}>
        <select value={f.expense_type} onChange={e => setF({ ...f, expense_type: e.target.value })}>{lookups.expenseTypes.map(x => <option key={x} value={x}>{EXPENSE_LABEL[x]}</option>)}</select>
        <input type="text" placeholder="Budget code" value={f.code} onChange={e => setF({ ...f, code: e.target.value })} required style={{ width: 130 }} />
        <input type="text" placeholder="Description" value={f.description} onChange={e => setF({ ...f, description: e.target.value })} required style={{ flex: 1 }} />
        <button className="primary" disabled={busy}>Add</button>
      </form>
      {lookups.expenseTypes.map(t => {
        const list = lookups.budgetCodes.filter(b => b.expense_type === t);
        return (
          <div key={t}>
            <div className="section-title">{EXPENSE_LABEL[t]}</div>
            {list.length === 0 ? <div className="hint">No codes yet.</div> : (
              <div className="tbl-wrap" style={{ maxHeight: 'none' }}><table>
                <thead><tr><th>Budget code</th><th>Description</th><th>Active</th><th></th></tr></thead>
                <tbody>{list.map(b => {
                  const e = edit[b.id];
                  return (
                    <tr key={b.id} style={b.active ? undefined : { opacity: 0.55 }}>
                      <td>{e ? <input type="text" value={e.code} onChange={ev => setEdit({ ...edit, [b.id]: { ...e, code: ev.target.value } })} style={{ width: 120 }} /> : b.code}</td>
                      <td className="wrap">{e ? <input type="text" value={e.description} onChange={ev => setEdit({ ...edit, [b.id]: { ...e, description: ev.target.value } })} /> : b.description}</td>
                      <td><input type="checkbox" checked={!!b.active} onChange={() => go(() => api.put('/lookups/budget-codes/' + b.id, { active: !b.active }), 'Updated.')} style={{ width: 16 }} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>{e
                        ? <><button className="mini plain" disabled={busy} onClick={async () => { if (await go(() => api.put('/lookups/budget-codes/' + b.id, e), 'Budget code updated.')) setEdit({ ...edit, [b.id]: undefined }); }}>save</button> <button className="mini" onClick={() => setEdit({ ...edit, [b.id]: undefined })}>cancel</button></>
                        : <button className="mini plain" onClick={() => setEdit({ ...edit, [b.id]: { code: b.code, description: b.description } })}>edit</button>}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const SUPPLIES_PERIODS = [
  ['pb_days', 'Performance Bond due (days after notifying the supplier)'], ['pi_days', 'Proforma invoice due (days after notifying)'],
  ['reminder_interval_days', 'Repeat supplier reminders every (days)'], ['bond_notice_days', 'Bond expiry notice (days before expiry)'],
  ['pb_validity_extra_days', 'Performance Bond validity (days after delivery)'], ['contract_agreement_days', 'Contract agreement due (days after award)']
];

function SuppliesSettings() {
  const { lookups, reload } = useApp();
  const [dept, setDept] = useState(lookups.suppliesUnit.department_id || '');
  const [periods, setPeriods] = useState(null);
  const { busy, error, ok, run } = useAction();
  useEffect(() => { api.get('/supplies/settings').then(setPeriods).catch(() => {}); }, []);
  const heads = lookups.departments.find(d => d.id === Number(dept));
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>Supplies Unit</h2>
      <p className="hint">Users with the role "Supplies Unit" handle the files forwarded after award. The head (Department head role) of the department chosen here can view the whole Supplies function, read-only.</p>
      <Msg error={error} ok={ok} />
      <label className="field"><span>Supplies department</span>
        <select value={dept} onChange={e => setDept(e.target.value)}>
          <option value="">— not set —</option>{lookups.departments.filter(d => d.active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select></label>
      <button className="primary" disabled={busy} onClick={async () => { if (await run(() => api.put('/lookups/supplies-unit', { department_id: dept || null }), heads ? `Heads of ${heads.name} can now view Supplies.` : 'Cleared.')) reload(); }}>Save</button>
      {periods && <>
        <div className="section-title">Supplies time periods</div>
        <div className="grid g2">{SUPPLIES_PERIODS.map(([k, l]) => (
          <label className="field" key={k}><span>{l}</span><input type="number" min="1" max="365" value={periods[k]} onChange={e => setPeriods({ ...periods, [k]: e.target.value })} /></label>
        ))}</div>
        <button className="primary" disabled={busy} onClick={() => run(() => api.put('/supplies/settings', periods), 'Supplies time periods saved.')}>Save periods</button>
      </>}
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
        <SuppliesSettings />
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
        {[['users', 'Users'], ['org', 'Divisions, departments & sub units'], ['categories', 'Procurement categories'], ['budget-codes', 'Budget codes'], ['settings', 'Limits, reminders & organisation'], ['audit', 'Audit trail']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'org' && <Org />}
      {tab === 'categories' && <Categories />}
      {tab === 'budget-codes' && <BudgetCodes />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}
