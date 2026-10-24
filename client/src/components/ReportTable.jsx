import { downloadCsv, fmt } from '../lib/format.js';

const isMoney = c => c.align === 'right';

// Renders a server-shaped report ({ meta, title, subtitle, columns, rows, summary }) with CSV export and print.
export default function ReportTable({ report, filename }) {
  const { meta, title, subtitle, columns, rows, summary } = report;
  return (
    <div className="report">
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className="primary" onClick={() => window.print()}>Print / save as PDF</button>
        <button className="ghost" onClick={() => downloadCsv(filename + '.csv', columns, rows)}>Download CSV</button>
      </div>
      <div className={'report-sheet' + (report.landscape ? ' landscape' : '')}>
        <div className="report-head">
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>{meta.org}</div>
          <h2 style={{ margin: '2px 0 4px', fontSize: 17 }}>{title}</h2>
          <div className="hint" style={{ margin: 0 }}>{subtitle}</div>
          <div className="hint" style={{ margin: '4px 0 12px' }}>
            Plan status: {String(meta.plan_status).replace('_', ' ')} · version {meta.plan_version} · generated {new Date(meta.generated_at).toLocaleString()}
          </div>
        </div>
        {summary && (
          <div className="grid g4" style={{ marginBottom: 14 }}>
            {summary.map(s => <div className="stat" key={s.label}><div className="v">{s.value}</div><div className="l">{s.label}</div></div>)}
          </div>
        )}
        {rows.length === 0 ? <div className="empty">No data for this selection.</div> : (
          <div className="tbl-wrap report-scroll">
            <table>
              <thead><tr>{columns.map(c => <th key={c.key} style={{ textAlign: isMoney(c) ? 'right' : 'left' }}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r._total ? 'total-row' : ''}>
                    {columns.map(c => (
                      <td key={c.key} style={{ textAlign: isMoney(c) ? 'right' : 'left' }}>
                        {isMoney(c) && !c.int && typeof r[c.key] === 'number' && c.key !== 'count' && c.key !== 'delay_days' ? fmt(r[c.key]) : (r[c.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
