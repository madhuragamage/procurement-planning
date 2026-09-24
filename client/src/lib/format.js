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
  procurement: 'Procurement unit', management: 'Management', executive: 'Board / CEO'
};

export const FUNDING_LABEL = { LECO: 'LECO (own funds)', GOSL: 'GOSL', Foreign: 'Foreign funded', Grant: 'Grant' };
export const REASON_LABEL = { ROL: 'ROL (re-order level)', Replacement: 'Replacement', New: 'New', Other: 'Other' };
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
