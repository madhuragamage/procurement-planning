// Bid Evaluation Committee (BEC, also called the TEC) rules: the committee's two tasks, member performance
// and the wording of appointment / activation / reminder e-mails. Pure functions - no I/O.
const { diffDays } = require('./rules');

const ROLE_LABEL = { chair: 'Chairperson', member: 'Member', secretary: 'Secretary' };

// The BEC's two tasks in a procurement, each activated separately with its own due date. Completing a task
// records its milestone in the procurement's schedule.
const STAGES = {
  1: { key: 'prep', label: 'Preparation of bidding documents / specifications', short: 'Bidding documents', milestone: 'prep_docs', activation: 'on appointment' },
  2: { key: 'eval', label: 'Bid evaluation', short: 'Bid evaluation', milestone: 'evaluation', activation: 'after bid opening' }
};

// One member's record over their tasks. Each row needs: due_date, submitted_on, and the task's start
// (activated_on, or appointed_on for older rows); a task is closed when its stage_completed_on is set
// (or committee_status is 'completed').
function performance(rows, today) {
  const p = { assignments: rows.length, on_time: 0, late: 0, pending: 0, overdue: 0, not_submitted: 0, avg_days_taken: null, avg_days_late: null, on_time_pct: null };
  let taken = 0, takenN = 0, lateDays = 0;
  for (const r of rows) {
    const start = r.activated_on || r.appointed_on;
    const closed = !!r.stage_completed_on || r.committee_status === 'completed';
    if (r.submitted_on) {
      taken += diffDays(start, r.submitted_on); takenN += 1;
      const late = diffDays(r.due_date, r.submitted_on);
      if (late > 0) { p.late += 1; lateDays += late; } else p.on_time += 1;
    } else if (closed) p.not_submitted += 1;
    else if (r.due_date < today) p.overdue += 1;
    else p.pending += 1;
  }
  const decided = p.on_time + p.late + p.overdue + p.not_submitted;
  if (takenN) p.avg_days_taken = Math.round((taken / takenN) * 10) / 10;
  if (p.late) p.avg_days_late = Math.round((lateDays / p.late) * 10) / 10;
  if (decided) p.on_time_pct = Math.round((p.on_time / decided) * 1000) / 10;
  return p;
}

// One task's outcome against the time given (activation to due date).
function outcome(r, today) {
  const start = r.activated_on || r.appointed_on;
  const allowed = diffDays(start, r.due_date);
  if (r.submitted_on) {
    const late = diffDays(r.due_date, r.submitted_on);
    return { key: late > 0 ? 'late' : 'on_time', label: late > 0 ? `Completed ${late} d late` : 'Completed within time', allowed, taken: diffDays(start, r.submitted_on), late: Math.max(0, late) };
  }
  if (r.stage_completed_on || r.committee_status === 'completed') return { key: 'not_submitted', label: 'Not submitted (task closed)', allowed, taken: null, late: null };
  if (r.due_date < today) return { key: 'overdue', label: `Overdue ${diffDays(r.due_date, today)} d`, allowed, taken: null, late: diffDays(r.due_date, today) };
  return { key: 'pending', label: `In progress — ${diffDays(today, r.due_date)} d left`, allowed, taken: null, late: null };
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

// Appointment: both tasks explained; task 1 (bidding documents) starts now with its due date. `c.due_date`
// is the task 1 due date. A member added later while task 2 is active is told about task 2 instead.
function appointmentMail({ member, role, c, org, sig, today, activeStage }) {
  const s2 = activeStage === 2;
  return {
    subject: `Appointment to the Bid Evaluation Committee — ${c.bid_no || c.ref_no}${c.letter_ref ? ` (Ref: ${c.letter_ref})` : ''}`,
    text: `${heading(c, today || c.appointed_on)}\n\nDear ${member.name},\n\nAPPOINTMENT TO THE BID EVALUATION COMMITTEE\n\nYou have been appointed as ${ROLE_LABEL[role] || 'Member'} of the Bid Evaluation Committee (BEC) for the following procurement:\n\n${describe(c)}\n\nDate of appointment: ${longDate(c.appointed_on)}\n\nThe committee has two tasks, each started separately:\n  1. ${STAGES[1].label}${s2 ? ' (completed)' : ` — starts now; to be completed by ${longDate(c.due_date)}`}\n  2. ${STAGES[2].label}${s2 ? ` — in progress; to be completed by ${longDate(c.stage_due)}` : ' — you will be notified separately when the bids have been opened and this task starts, with its own due date'}\n\nYou will receive a reminder before each due date. Please contact the undersigned if you are unable to serve on this committee.\n\n${signature(sig, org)}`
  };
}

// Task 2 (bid evaluation) activated: its own start and due date.
function stageActivatedMail({ member, c, stage, org, sig, today }) {
  return {
    subject: `${STAGES[stage].label} task started — ${c.bid_no || c.ref_no} — due ${longDate(c.stage_due)}`,
    text: `${heading(c, today)}\n\nDear ${member.name},\n\n${STAGES[stage].label.toUpperCase()} — TASK STARTED\n\nThe second task of the Bid Evaluation Committee for the procurement below has started today. Please complete the ${STAGES[stage].label.toLowerCase()} and submit it to the procurement unit by ${longDate(c.stage_due)}.\n\n${describe(c)}${c.letter_ref ? `\nAppointment letter: ${c.letter_ref} dated ${longDate(c.appointed_on)}` : ''}\n\nYou will receive a reminder before this date.\n\n${signature(sig, org)}`
  };
}

// Reminder for the task in progress. `c.stage_due` is that task's due date.
function reminderMail({ member, c, kind, today, org, sig, stage = 1 }) {
  const due = c.stage_due || c.due_date;
  const days = diffDays(today, due);
  const overdue = kind === 'overdue' || days < 0;
  const task = STAGES[stage].label;
  return {
    subject: overdue
      ? `OVERDUE: ${task} for ${c.bid_no || c.ref_no} was due on ${longDate(due)}`
      : `Reminder: ${task} for ${c.bid_no || c.ref_no} is due on ${longDate(due)}`,
    text: `${heading(c, today)}\n\nDear ${member.name},\n\n${overdue ? `${task.toUpperCase()} — TIME LAPSED` : `REMINDER — ${task.toUpperCase()}`}\n\n${overdue
      ? `The time given to the Bid Evaluation Committee for the ${task.toLowerCase()} (task ${stage} of 2) for the procurement below lapsed on ${longDate(due)}${days < 0 ? ` (${-days} day${days === -1 ? '' : 's'} ago)` : ''}, and your part has not been recorded as submitted. Please complete it and submit it to the procurement unit without delay.`
      : `This is a reminder that the ${task.toLowerCase()} (task ${stage} of 2) for the procurement below is due on ${longDate(due)} (${days} day${days === 1 ? '' : 's'} from today), and your part has not been recorded as submitted yet.`}\n\n${describe(c)}${c.letter_ref ? `\nAppointment letter: ${c.letter_ref} dated ${longDate(c.appointed_on)}` : ''}\n\n${signature(sig, org)}`
  };
}

module.exports = { ROLE_LABEL, STAGES, SIGNATURE_FIELDS, longDate, signature, performance, outcome, appointmentMail, stageActivatedMail, reminderMail };
