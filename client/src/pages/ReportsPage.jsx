import { useEffect, useState } from 'react';
import { api, qs } from '../api.js';
import { useApp } from '../context/AppContext.jsx';
import ReportTable from '../components/ReportTable.jsx';

const REPORTS = [
  ['mpp', 'Master Procurement Plan (MPP) — Annex I'],
  ['appp', 'Annual Procurement Plan (APPP) — Annex II'],
  ['dapp', 'Detailed Annual Procurement Plan (DAPP) — Annex III'],
  ['preparatory', 'Preparatory Procurement Plan — Annex VI'],
  ['by-category', 'Category-wise listing'],
  ['dept-category', 'Department × category summary'],
  ['by-division', 'Summary by division and department'],
  ['by-method', 'Summary by method'],
  ['by-committee', 'Summary by committee'],
  ['performance', 'Quarterly Procurement Performance Report'],
  ['budget', 'Budget availability']
];

export default function ReportsPage() {
  const { fy, lookups } = useApp();
  const [type, setType] = useState('mpp');
  const [dept, setDept] = useState('');
  const [cat, setCat] = useState('');
  const [quarter, setQuarter] = useState(Math.min(4, Math.floor(new Date().getMonth() / 3) + 1));
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true); setError('');
    const path = type === 'budget' ? '/reports/budget' + qs({ year: fy }) : `/reports/${type}` + qs({ plan_fy: fy, department_id: dept, category_id: cat, quarter: type === 'performance' ? quarter : undefined });
    api.get(path).then(setReport).catch(e => { setReport(null); setError(e.message); }).finally(() => setLoading(false));
  }, [type, fy, dept, cat, quarter]);

  const filterable = !['budget'].includes(type);

  return (
    <div>
      <div className="card no-print" style={{ marginBottom: 16 }}>
        <div className="grid g4">
          <label className="field" style={{ gridColumn: 'span 2' }}><span>Report</span>
            <select value={type} onChange={e => setType(e.target.value)}>{REPORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {filterable && <label className="field"><span>Department</span>
            <select value={dept} onChange={e => setDept(e.target.value)}><option value="">All</option>{lookups.departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
          {filterable && <label className="field"><span>Category</span>
            <select value={cat} onChange={e => setCat(e.target.value)}><option value="">All</option>{lookups.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          {type === 'performance' && <label className="field"><span>Quarter</span>
            <select value={quarter} onChange={e => setQuarter(Number(e.target.value))}>{[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}</select></label>}
        </div>
        <p className="hint" style={{ margin: 0 }}>Plan cycle {fy} (change it in the top bar). Use "Print / save as PDF" to produce a document for the line ministry or management, or download the CSV.</p>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="loading"><span className="spinner"></span> Building report…</div>}
      {report && !loading && <ReportTable report={report} filename={`${type}-${fy}`} />}
    </div>
  );
}
