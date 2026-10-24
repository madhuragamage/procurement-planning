import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useApp } from '../context/AppContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { ROLE_LABEL, canSeeSupplies } from '../lib/format.js';
import { FySelect } from './ui.jsx';

// [path, label, roles allowed to see the tab (null = everyone)]
const TABS = [
  ['dashboard', 'Dashboard', null],
  ['board', 'Board / CEO', ['executive', 'management', 'admin', 'procurement']],
  ['requests', 'Requests', ['requester', 'dept_head', 'procurement', 'admin']],
  ['authorisations', 'Authorise', ['dept_head', 'admin']],
  ['inbox', 'Procurement inbox', ['procurement', 'admin']],
  ['plan', 'Plan', null],
  ['revisions', 'Revisions', ['procurement', 'management', 'admin', 'executive']],
  ['execution', 'Execution', null],
  ['tec', 'BEC / TEC', ['procurement', 'management', 'admin', 'executive']],
  ['supplies-progress', 'Supplies progress', 'supplies'],
  ['supplies', 'Supplies files', 'supplies'],
  ['budgets', 'Budgets', null],
  ['reports', 'Reports', null],
  ['admin', 'Admin', ['admin']]
];

export default function TopNav() {
  const { user, logout } = useAuth();
  const { lookups, fy, setFy } = useApp();
  const { theme, toggleTheme } = useTheme();
  // Supplies Unit officers only work with the Supplies files forwarded to them.
  const SUPPLIES_ONLY = ['supplies-progress', 'supplies', 'reports'];
  const tabs = TABS.filter(([path, , roles]) => (user.role === 'supplies' ? SUPPLIES_ONLY.includes(path)
    : !roles || (roles === 'supplies' ? canSeeSupplies(user, lookups) : roles.includes(user.role))));

  return (
    <header className="top no-print">
      <div className="brand">
        <div className="mark"></div>
        <div>
          <h1 style={{ fontSize: 16, margin: 0 }}>Procurement Planning</h1>
          <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2, fontFamily: 'var(--mono)' }}>
            {lookups.org.name || 'LECO'} · National Procurement Manual 2024, Ch. 4
          </span>
        </div>
      </div>
      <nav className="tabs">
        {tabs.map(([path, name]) => (
          <NavLink key={path} to={'/app/' + path} className={({ isActive }) => isActive ? 'active' : ''}>{name}</NavLink>
        ))}
      </nav>
      <div className="headright">
        {user.role !== 'supplies' && <FySelect fy={fy} setFy={setFy} />}
        <button className="iconbtn" onClick={toggleTheme}>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
        <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right' }}>
          {user.name}<br />{ROLE_LABEL[user.role]}{user.department ? ' · ' + user.department : ''}{user.sub_unit ? ' / ' + user.sub_unit : ''}
        </span>
        <button className="iconbtn" onClick={logout}>Sign out</button>
      </div>
    </header>
  );
}
