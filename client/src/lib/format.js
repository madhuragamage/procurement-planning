export const fmt = n => (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) ? '' :
  Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const inclVat = (excl, vat) => Math.round((Number(excl) || 0) * (1 + (Number(vat) || 0) / 100) * 100) / 100;

export const STATUS_CLASS = {
  draft: 'warn', submitted: 'warn', returned: 'bad', rejected: 'bad', authorised: 'ok',
  planning: 'warn', changes_requested: 'bad', approved: 'ok', frozen: 'ok',
  planned: 'warn', in_progress: 'warn', awarded: 'ok', completed: 'ok', cancelled: 'bad',
  pending: 'warn', requested: 'warn', accepted: 'ok', not_requested: 'warn'
};

export const label = s => String(s || '').replace(/_/g, ' ');

export const ROLE_LABEL = {
  admin: 'Administrator', requester: 'Department user', dept_head: 'Department head',
  procurement: 'Procurement unit', management: 'Management', executive: 'Board / CEO', supplies: 'Supplies Unit'
};
// Who may see the Supplies function: the Supplies Unit and the wider roles, plus (read-only) the head of
// the department the admin has marked as the Supplies department.
export const canSeeSupplies = (user, lookups) => ['supplies', 'procurement', 'management', 'admin', 'executive'].includes(user.role)
  || (user.role === 'dept_head' && !!lookups?.suppliesUnit?.department_id && user.department_id === lookups.suppliesUnit.department_id);
export const BID_TYPE = { tender: 'Tender', quotation: 'Quotation' };
// Default class for a method: competitive bidding is a tender, shopping a quotation.
export const suggestBidType = method => (['ICB', 'LIB', 'NCB', 'LNB'].includes(method) ? 'tender' : String(method || '').startsWith('Shopping') ? 'quotation' : '');

export const FUNDING_LABEL = { LECO: 'LECO (own funds)', GOSL: 'GOSL', Foreign: 'Foreign funded', Grant: 'Grant' };
export const REASON_LABEL = { ROL: 'ROL (re-order level)', New: 'New', Replacement: 'Replacement', 'Action Plan': 'Action Plan', 'Projects-ADB': 'Projects-ADB', 'Projects-LECO': 'Projects-LECO', Other: 'Other' };
export const EXPENSE_LABEL = { CAPEX: 'CAPEX (Capital)', OPEX: 'OPEX (Operational)', Inventory: 'Inventory' };
export const MAIN_CATEGORY_LABEL = { goods: 'Goods', works: 'Works', services: 'Non-Consultancy Services', consultancy: 'Consultancy Services' };
// "2026: 40% · 2027: 60%" for a request/item whose budget is phased over years; '' otherwise.
export const phasingLabel = r => Array.isArray(r.budget_phasing) && r.budget_phasing.length > 1
  ? r.budget_phasing.map((p, k) => `${Number(r.plan_fy) + Number(r.year_offset) + k}: ${p}%`).join(' · ') : '';
export const recurLabel = r => r.recurrence === 'recurrent' ? `recurrent +${Number(r.annual_increase_pct)}%/yr` : 'one time';
// Estimate for each year a recurrent need repeats in, from its year in the cycle to the end of the cycle.
export const recurYears = (excl, vat, pct, offset) => {
  const out = [];
  for (let k = 0; offset + k <= 2; k++) out.push({ offset: offset + k, incl: inclVat((Number(excl) || 0) * Math.pow(1 + (Number(pct) || 0) / 100, k), vat) });
  return out;
};
export const EXEC_LABEL = { not_requested: 'not requested', requested: 'requested', accepted: 'accepted', returned: 'returned' };

export const pct = n => (n === null || n === undefined ? '' : `${Number(n).toFixed(1)}%`);

export const YEAR_LABELS = fy => [`${fy} (annual)`, `${fy + 1} (tentative)`, `${fy + 2} (tentative)`];
export const PRIORITY = { U: 'Urgent', P: 'Priority', N: 'Normal' };

export function downloadCsv(filename, columns, rows) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(c => esc(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map(c => esc(r[c.key])).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
