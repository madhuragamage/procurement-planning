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

function appointmentMail({ member, role, c, org }) {
  return {
    subject: `Appointment to the Technical Evaluation Committee — ${c.bid_no || c.ref_no}`,
    text: `Dear ${member.name},\n\nYou have been appointed as ${ROLE_LABEL[role] || 'Member'} of the Technical Evaluation Committee (TEC) for the following procurement:\n\n${describe(c)}\n\nDate of appointment: ${c.appointed_on}\nThe technical evaluation must be completed and the report submitted by: ${c.due_date}\n\nYou will receive a reminder before this date. Please contact the procurement unit if you cannot serve on this committee.\n\n${org || 'Procurement Unit'}`
  };
}

function reminderMail({ member, c, kind, today, org }) {
  const days = diffDays(today, c.due_date);
  const overdue = kind === 'overdue' || days < 0;
  return {
    subject: overdue
      ? `OVERDUE: Technical evaluation for ${c.bid_no || c.ref_no} was due on ${c.due_date}`
      : `Reminder: Technical evaluation for ${c.bid_no || c.ref_no} is due on ${c.due_date}`,
    text: `Dear ${member.name},\n\n${overdue
      ? `The time given to the Technical Evaluation Committee for the procurement below lapsed on ${c.due_date}${days < 0 ? ` (${-days} day${days === -1 ? '' : 's'} ago)` : ''}, and your evaluation has not been recorded as submitted. Please complete it and submit it to the procurement unit without delay.`
      : `This is a reminder that the technical evaluation for the procurement below is due on ${c.due_date} (${days} day${days === 1 ? '' : 's'} from today), and your evaluation has not been recorded as submitted yet.`}\n\n${describe(c)}\n\n${org || 'Procurement Unit'}`
  };
}

module.exports = { ROLE_LABEL, performance, appointmentMail, reminderMail };
