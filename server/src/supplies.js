// Supplies Department post-award process (Supplies Dept work procedure). Each step applies only when the
// contract needs it (imports, proof approval, advance payment...), may have a due date, and is done when
// its date is recorded. Pure functions - no I/O.
const { addDays, diffDays } = require('./rules');

const DEFAULTS = { pb_days: 14, pi_days: 14, pb_validity_extra_days: 60, bond_notice_days: 7, reminder_interval_days: 7, contract_agreement_days: 30 };

const isImport = c => c.payment_mode === 'LC' || c.payment_mode === 'TT';

// Next working day(s) after a date (Saturday and Sunday skipped; public holidays are not known).
function addWorkingDays(iso, n) {
  let d = iso;
  for (let i = 0; i < n;) {
    d = addDays(d, 1);
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) i += 1;
  }
  return d;
}

const STEPS = [
  { key: 'file_received', group: 'Receipt and acceptance', label: 'File received from the Procurement Department' },
  { key: 'accepted', group: 'Receipt and acceptance', label: 'Accepted in the system and award details updated', due: c => c.forwarded_on, rule: 'same day' },
  { key: 'po_copies_sent', group: 'Receipt and acceptance', label: 'P/Order copies sent to Finance and Stock Control Departments' },
  { key: 'supplier_informed', group: 'Receipt and acceptance', label: 'Supplier informed to submit the Performance Bond and Proforma Invoice', due: c => c.accepted_on && addWorkingDays(c.accepted_on, 1), rule: 'within one working day' },

  { key: 'pb_received', group: 'Performance bond and proforma invoice', label: 'Performance Bond received', due: c => c.pb_due, rule: 'period given after notification' },
  { key: 'pi_received', group: 'Performance bond and proforma invoice', label: 'Proforma invoice received', due: c => c.pi_due, rule: 'period given after notification' },
  { key: 'pb_to_legal', group: 'Performance bond and proforma invoice', label: 'Performance Bond sent to the Legal Department for checking' },
  { key: 'pb_legal_cleared', group: 'Performance bond and proforma invoice', label: 'Legal clearance of the Performance Bond' },
  { key: 'bid_bond_released', group: 'Performance bond and proforma invoice', label: 'Bid bond released (after the Performance Bond is received)', when: c => Number(c.bid_bond_amount) > 0 },

  { key: 'ab_received', group: 'Advance payment bond', label: 'Advance Payment Bond received', when: c => !!c.advance_bond_required },
  { key: 'ab_to_legal', group: 'Advance payment bond', label: 'Advance Payment Bond sent to the Legal Department', when: c => !!c.advance_bond_required },
  { key: 'ab_legal_cleared', group: 'Advance payment bond', label: 'Legal clearance of the Advance Payment Bond', when: c => !!c.advance_bond_required },

  { key: 'proof_requested', group: 'Proof approval (printing)', label: 'Supplier instructed to submit the sample / proof', when: c => !!c.proof_required },
  { key: 'proof_sent', group: 'Proof approval (printing)', label: 'Sample sent to the relevant department for checking', when: c => !!c.proof_required },
  { key: 'proof_recommended', group: 'Proof approval (printing)', label: 'Recommendation of the relevant department obtained', when: c => !!c.proof_required },
  { key: 'proof_supplier_informed', group: 'Proof approval (printing)', label: 'Supplier informed to collect the original approval', when: c => !!c.proof_required },
  { key: 'proof_emailed', group: 'Proof approval (printing)', label: 'Scanned approval e-mailed to the supplier', when: c => !!c.proof_required },

  { key: 'contract_agreement', group: 'Contract agreement', label: 'Contract agreement prepared and completed', when: c => !!c.contract_agreement_required, due: (c, s) => c.award_date && addDays(c.award_date, s.contract_agreement_days), rule: 'within one month of award' },

  { key: 'lc_application', group: 'LC / TT', label: 'LC / TT application prepared', when: isImport },
  { key: 'lc_signatures', group: 'LC / TT', label: 'Authorised signatures obtained', when: isImport },
  { key: 'lc_to_bank', group: 'LC / TT', label: 'Application handed over to the bank', when: isImport },
  { key: 'lc_confirmed', group: 'LC / TT', label: 'LC / TT opening confirmed by the bank', when: isImport },

  { key: 'fat_arranged', group: 'Factory acceptance test', label: 'Physical / online FAT arranged with the supplier and LECO officers', when: c => !!c.fat_required },
  { key: 'fat_docs', group: 'Factory acceptance test', label: 'Technical documents scanned and e-mailed to the parties', when: c => !!c.fat_required },
  { key: 'fat_completed', group: 'Factory acceptance test', label: 'FAT completed', when: c => !!c.fat_required },

  { key: 'dw_letters', group: 'Duty waiver', label: 'Duty waiver letters prepared', when: c => !!c.duty_waiver_required },
  { key: 'dw_gm', group: 'Duty waiver', label: 'General Manager\'s signature obtained', when: c => !!c.duty_waiver_required },
  { key: 'dw_ministry', group: 'Duty waiver', label: 'Letters handed over to the Ministry', when: c => !!c.duty_waiver_required },
  { key: 'dw_collected', group: 'Duty waiver', label: 'Authorised duty waiver collected from the Ministry', when: c => !!c.duty_waiver_required },

  { key: 'bank_docs', group: 'Import clearance', label: 'Original documents collected from the bank', when: isImport },
  { key: 'clearing_agent', group: 'Import clearance', label: 'Original documents (and duty waiver) handed over to the clearing agent', when: isImport },
  { key: 'customs_letters', group: 'Import clearance', label: 'Letters to Customs prepared', when: isImport },

  { key: 'goods_delivered', group: 'Delivery and handover', label: 'Goods delivered to stores (Ekala / Waskaduwa)', due: c => c.delivery_date, rule: 'contract delivery date' },
  { key: 'inspection_done', group: 'Delivery and handover', label: 'Material inspection completed by the authorised officer' },
  { key: 'handed_over', group: 'Delivery and handover', label: 'Distributed / handed over to the user departments' },
  { key: 'invoice_to_finance', group: 'Delivery and handover', label: 'Tax invoice sent to the Finance Department', when: c => c.order_type === 'letter_of_acceptance' },
  { key: 'file_to_stock', group: 'Delivery and handover', label: 'File sent to the Stock Control Department (File Delivery Book)' }
];
const STEP_KEYS = STEPS.map(s => s.key);

// The contract's applicable steps with their state, plus the next pending one and overdue count.
function steps(c, settings, today) {
  const s = { ...DEFAULTS, ...(settings || {}) };
  const done = c.steps || {};
  const list = STEPS.filter(x => !x.when || x.when(c)).map(x => {
    const rec = done[x.key] || {};
    const due = x.due ? x.due(c, s) || null : null;
    const date = rec.date || null;
    return { key: x.key, group: x.group, label: x.label, rule: x.rule || null, date, note: rec.note || null, due,
      overdue: !date && !!due && due < today, late_days: date && due ? Math.max(0, diffDays(due, date)) : null };
  });
  const pending = list.filter(x => !x.date);
  return {
    list, total: list.length, done: list.length - pending.length,
    pct: list.length ? Math.round(((list.length - pending.length) / list.length) * 100) : 0,
    next: pending[0] || null, overdue: list.filter(x => x.overdue)
  };
}

// Performance Bond is valid until delivery + N days unless set otherwise.
const pbValidity = (deliveryDate, settings) => deliveryDate ? addDays(deliveryDate, (settings && settings.pb_validity_extra_days) || DEFAULTS.pb_validity_extra_days) : null;

function describe(c) {
  return `Bid No: ${c.bid_no || '-'}\nProcurement ref: ${c.ref_no}\n${c.title}${c.order_no ? `\nOrder No: ${c.order_no}` : ''}`;
}

function supplierReminderMail({ c, what, today, org }) {
  const doc = what === 'pb' ? 'Performance Bond' : 'Proforma Invoice';
  const due = what === 'pb' ? c.pb_due : c.pi_due;
  const late = due ? diffDays(due, today) : 0;
  return {
    subject: `Reminder: ${doc} for ${c.bid_no || c.ref_no} ${late > 0 ? 'overdue' : 'due'}`,
    text: `Dear Sir / Madam,\n\n${c.supplier_name ? `${c.supplier_name}\n\n` : ''}We refer to the award of the contract below. The ${doc} was due on ${due || '-'}${late > 0 ? ` (${late} days ago)` : ''} and has not been received. Please submit it to the Supplies Department without further delay.\n\n${describe(c)}\n\n${org || ''}\nSupplies Department`
  };
}

function deliveryReminderMail({ c, today, org }) {
  const late = c.delivery_date ? diffDays(c.delivery_date, today) : 0;
  return {
    subject: `Delivery overdue: ${c.bid_no || c.ref_no}`,
    text: `Dear Sir / Madam,\n\n${c.supplier_name ? `${c.supplier_name}\n\n` : ''}The goods / services under the contract below were due for delivery on ${c.delivery_date || '-'}${late > 0 ? ` and are now ${late} days overdue` : ''}. Please deliver without further delay or inform us of the revised delivery date with reasons.\n\n${describe(c)}\n\n${org || ''}\nSupplies Department`
  };
}

function bondExpiryMail({ b, c, today }) {
  const days = diffDays(today, b.expiry_date);
  const kind = { bid: 'Bid bond', performance: 'Performance Bond', advance: 'Advance Payment Bond' }[b.kind];
  return {
    subject: `${kind}${b.bond_no ? ' ' + b.bond_no : ''} for ${c.bid_no || c.ref_no} expires on ${b.expiry_date}`,
    text: `${kind}${b.bond_no ? ' ' + b.bond_no : ''}${b.bank ? ` (${b.bank})` : ''} for the contract below expires on ${b.expiry_date} (${days} day${days === 1 ? '' : 's'} from today).\n\nIf the contractual obligations will not be completed by then, request the supplier to extend the validity; if it is not extended, prepare the forfeiture letter for the AGM (Engineering)'s signature.\n\nSupplier: ${c.supplier_name || '-'}\n${describe(c)}`
  };
}

module.exports = { DEFAULTS, STEPS, STEP_KEYS, addWorkingDays, steps, pbValidity, isImport, supplierReminderMail, deliveryReminderMail, bondExpiryMail };
