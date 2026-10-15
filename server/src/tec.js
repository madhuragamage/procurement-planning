// Technical Evaluation Committee rules: member performance and the wording of appointment / reminder
// e-mails. Pure functions - no I/O.
const { diffDays } = require('./rules');

const ROLE_LABEL = { chair: 'Chairperson', member: 'Member', secretary: 'Secretary' };

// One member's record over their (non-cancelled) committee assignments. Each row needs: due_date,
// appointed_on, submitted_on, committee_status.
function performance(rows, today) {
  const p = { assignments: rows.length, on_time: 0, late: 0, pending: 0, overdue: 0, not_submitted: 0, avg_days_taken: null, avg_days_late: null, on_time_pct: null };
  let taken = 0, takenN = 0, lateDays = 0;
  for (const r of rows) {
    if (r.submitted_on) {
      taken += diffDays(r.appointed_on, r.submitted_on); takenN += 1;
      const late = diffDays(r.due_date, r.submitted_on);
      if (late > 0) { p.late += 1; lateDays += late; } else p.on_time += 1;
    } else if (r.committee_status === 'completed') p.not_submitted += 1;
    else if (r.due_date < today) p.overdue += 1;
    else p.pending += 1;
  }
  const decided = p.on_time + p.late + p.overdue + p.not_submitted;
  if (takenN) p.avg_days_taken = Math.round((taken / takenN) * 10) / 10;
  if (p.late) p.avg_days_late = Math.round((lateDays / p.late) * 10) / 10;
  if (decided) p.on_time_pct = Math.round((p.on_time / decided) * 1000) / 10;
  return p;
}

function describe(c) {
  return `${c.bid_no ? `Bid No: ${c.bid_no}\nProcurement ref: ` : ''}${c.ref_no} — ${c.title}\nDepartment: ${c.department}${c.method ? `\nProcurement method: ${c.method}` : ''}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// 2026-11-03 -> "3 November 2026"
const longDate = iso => {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

// Signature fields kept in the 'tec' setting; any left blank are omitted.
const SIGNATURE_FIELDS = ['signatory_name', 'signatory_designation', 'unit', 'organisation', 'phone', 'email'];

function signature(sig, org) {
  const s = sig || {};
  const lines = [s.signatory_name, s.signatory_designation, s.unit, s.organisation || org,
    s.phone && `Tel: ${s.phone}`, s.email && `E-mail: ${s.email}`].filter(Boolean);
  return `Thank you.\n\n${lines.length ? lines.join('\n') : 'Procurement Unit'}`;
}

// Letter-style heading: date of the e-mail and the appointment letter reference.
function heading(c, today) {
  return [`Date: ${longDate(today)}`, c.letter_ref && `Our ref: ${c.letter_ref}`].filter(Boolean).join('\n');
}

function appointmentMail({ member, role, c, org, sig, today }) {
  return {
    subject: `Appointment to the Technical Evaluation Committee — ${c.bid_no || c.ref_no}${c.letter_ref ? ` (Ref: ${c.letter_ref})` : ''}`,
    text: `${heading(c, today || c.appointed_on)}\n\nDear ${member.name},\n\nAPPOINTMENT TO THE TECHNICAL EVALUATION COMMITTEE\n\nYou have been appointed as ${ROLE_LABEL[role] || 'Member'} of the Technical Evaluation Committee (TEC) for the following procurement:\n\n${describe(c)}\n\nDate of appointment: ${longDate(c.appointed_on)}\nThe technical evaluation must be completed and the report submitted by: ${longDate(c.due_date)}\n\nYou will receive a reminder before this date. Please contact the undersigned if you are unable to serve on this committee.\n\n${signature(sig, org)}`
  };
}

function reminderMail({ member, c, kind, today, org, sig }) {
  const days = diffDays(today, c.due_date);
  const overdue = kind === 'overdue' || days < 0;
  return {
    subject: overdue
      ? `OVERDUE: Technical evaluation for ${c.bid_no || c.ref_no} was due on ${longDate(c.due_date)}`
      : `Reminder: Technical evaluation for ${c.bid_no || c.ref_no} is due on ${longDate(c.due_date)}`,
    text: `${heading(c, today)}\n\nDear ${member.name},\n\n${overdue ? 'TECHNICAL EVALUATION — TIME LAPSED' : 'REMINDER — TECHNICAL EVALUATION'}\n\n${overdue
      ? `The time given to the Technical Evaluation Committee for the procurement below lapsed on ${longDate(c.due_date)}${days < 0 ? ` (${-days} day${days === -1 ? '' : 's'} ago)` : ''}, and your evaluation has not been recorded as submitted. Please complete it and submit it to the procurement unit without delay.`
      : `This is a reminder that the technical evaluation for the procurement below is due on ${longDate(c.due_date)} (${days} day${days === 1 ? '' : 's'} from today), and your evaluation has not been recorded as submitted yet.`}\n\n${describe(c)}${c.letter_ref ? `\nAppointment letter: ${c.letter_ref} dated ${longDate(c.appointed_on)}` : ''}\n\n${signature(sig, org)}`
  };
}

module.exports = { ROLE_LABEL, SIGNATURE_FIELDS, longDate, signature, performance, appointmentMail, reminderMail };
