# LECO Procurement Planning

Web app for planning and tracking procurement under Sri Lanka's **National Procurement Manual 2024
(Goods, Works, Non-consulting Services), Chapter 4 – Procurement Planning**, including the periodic
progress reporting in Section 2.2.

Stack: React + Vite, Express, MySQL 8.4, nginx, docker-compose (same pattern as Feeder Island).

## Run

```bash
cp .env.example .env      # then set real passwords and a long random JWT_SECRET
docker compose up -d --build
```

Open http://localhost:8092 (port set by `CLIENT_PORT`). The first account you register becomes the
administrator; after that, registration is closed and the administrator creates all users
(Admin → Users). Never commit `.env`.

Development without Docker: run MySQL locally with `server/sql/schema.sql`, then `npm run dev` in
`server/` (needs the `DB_*`, `JWT_SECRET`, `FRONTEND_ORIGIN` env vars) and `npm run dev` in `client/`
(proxies `/api` to port 4000).

Rule and progress unit tests: `cd server && npm test`.

Database: `server/sql/schema.sql` is the version-1 baseline; the server applies the numbered migrations in
`server/src/migrations/` at start-up (tracked in `schema_migrations`), so existing databases upgrade in place.

## Workflow

1. **Request** – a department user or a **sub unit** creates a request (**main procurement category** Goods / Works /
   Non-Consultancy Services / Consultancy Services and its **sub category**, **budget category** CAPEX / OPEX /
   Inventory and a **budget code** of that category (codes maintained under Admin → Budget codes; required once a
   category has codes), **reason** ROL / New / Replacement / Action Plan / Projects-ADB / Projects-LECO / Other with an
   optional detail (required for Other), cost excl./incl. VAT, **funding** LECO (default) / GOSL / Foreign / Grant,
   required date, plan cycle and year, **one time or recurrent annually** with a yearly % increase, and optional
   **budget phasing** – the % of the value needed in the start year and up to two following years) and submits it.
   Each sub unit files independently and sees only its own requests. Reference numbers are
   `<plan year>-<running number>-<department code>`, e.g. `2027-01-DD`, numbered from 01 each plan year across all
   departments.
2. **Authorise** – the department head authorises, returns (with comment) or rejects it. Once authorised (received by
   the procurement unit), the procurement unit and the head of its department can **amend** the request until the plan
   is submitted for approval; amendments are logged and carried into the plan item.
3. **Procurement inbox** – the procurement unit assigns method, bidding procedure, prequalification,
   committee level, procurement start and expected delivery. Live checks against the Manual appear as
   warnings; a milestone schedule (Annex III) is drafted from the dates. **Date guidance** works back from the
   department's required date by the steps the method and value need (Section 6.3 bidding periods plus planning
   defaults for preparation, award and delivery – `DELIVERY_DAYS` in `rules.js`) and suggests start and delivery
   dates, or the earliest achievable delivery if the required date cannot be met. The **Expected dates** report
   tells each requesting department when its procurements are expected, against the date it asked for.
4. **Plan** – items form the annual plan (year 1) and tentative plans (years 2–3) of a cycle. Adding a recurrent
   request also creates its repeats in each later year of the cycle (ref `…/R1`, `…/R2`), with the estimate escalated
   by the yearly % (compounded) and the dates moved on a year each; they are separate items that can be edited on
   their own, and removing the original removes them. The
   procurement unit submits it; management approves it as submitted, **amends it and approves** (editing or
   removing items while it is submitted – each amendment is logged, items are marked "amended by management", and the
   approval and snapshot record the amendments), or returns it with comments; an approved plan is frozen. A
   procurement management **removes** is **rejected by management** (with the reason) – it does not go back to the
   procurement inbox. If required it can return: through a **plan revision** once the plan is approved, or by the
   procurement unit **reinstating** it (with a reason) while the plan is still being prepared.
5. **Revisions** – a frozen plan can only change through a bi-annual or urgent revision (add / modify /
   cancel). Management approval applies the changes atomically, bumps the plan version and stores a
   snapshot. Direct edits to a submitted/approved/frozen plan are rejected with HTTP 409.
6. **Execution** – once a plan is approved, its department users can view their own unit's items. When an item's
   planned start date is within the reminder lead time (default 30 days, Admin → Limits) the department is
   reminded on its dashboard and sends an **execution request**. Only the procurement unit accepts it (or returns
   it with a comment) and records revised/actual milestone dates, supplier and award value. Progress cannot be
   recorded before a request is accepted.
7. **Bid Evaluation Committees (BEC / TEC tab)** – the procurement unit keeps a directory of members (staff or
   external, no login needed) and appoints a BEC (chair, members, secretary) for an item in execution. The BEC has
   **two tasks, activated separately** so waiting for bids is never counted against it: task 1 *preparation of bidding
   documents / specifications* starts on appointment with its own due date; task 2 *bid evaluation* is started later
   (after bid opening, once task 1 is completed) with its own due date. Members submit per task and get reminders per
   task 7 days before its due date (setting `tec.reminder_days`) and once it lapses (hourly job, or on demand);
   extending a due date re-arms them. Appointment, task 1 and task 2 completion fill the "Appointment of BEC",
   "Preparation of bidding documents / specifications" and "Bid evaluation" milestones. Member performance and the
   BEC reports are counted per task (on time / late / overdue / not submitted, days allowed and taken, on-time rate
   per task).
   E-mail goes through the SMTP server in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`,
   `MAIL_FROM`); without it, messages are kept in the e-mail log as "not sent".
8. **Bid numbers** – when the P&P unit accepts (or itself starts) execution it classes the procurement as a tender or
   a quotation (suggested from the method) and it gets a bid number `T/<year>/<nnnn>` or `Q/<year>/<nnnn>` (prefixes in
   the `bid_numbering` setting). The bid number is shown with the procurement reference from then on. The procurement
   unit then sets the **time schedule** (Execution page): auto (standard lead times for the method and value) or custom
   weeks per milestone, counted from the previous milestone; the dates become each milestone's target (revised) date,
   while the approved plan dates remain the baseline.
9. **Supplies (Supplies tab, role "Supplies Unit")** – Supplies Unit officers handle the forwarded files (each file has
   a responsible officer). P&P forwards a file to a named officer or to the unit's in-tray. Officers see only their own
   files and the in-tray (open and completed) – no plan, requests, budgets or other pages – and land on the
   **Supplies progress** dashboard: each file's steps done against the time elapsed to its delivery target (on track /
   behind / overdue / delivered on time or late), deliveries due, on-time delivery rate and, for supervisors, per officer. The head of the department set as the Supplies department (Admin → Limits, reminders &
   organisation) can view everything read-only, including each officer's workload. Once the award is made, P&P forwards the file.
   Supplies accepts it (same day), enters the award details (supplier, P/O or LoA, local and foreign cost, CIF/FOB,
   freight, insurance, bid bond, bid validity, delivery date, Performance Bond amount and validity – default delivery +
   60 days) and records each step of the work procedure. Steps apply by contract: advance payment bond, proof approval,
   contract agreement (within a month of award), LC/TT, FAT, duty waiver, import clearance, Letter of Acceptance invoice.
   Informing the supplier sets the Performance Bond / proforma invoice due dates (14 days each, `supplies` setting);
   suppliers are e-mailed when these lapse and every 7 days after. Bond register (bid / performance / advance) with
   expiry notices to Supplies users 7 days ahead, extension and forfeiture tracking; deliveries in batches with
   inspection; supplier letters; delivery-extension / delay-waiver requests. Reports: status update schedule, bond
   register, delay-waiver approval schedule.
10. **Reports** – MPP (Annex I), APPP (Annex II), DAPP (Annex III, Schedule/Revised/Actual rows),
   Preparatory plan (Annex VI), category-wise, department × category, method and committee summaries,
   budget availability and the **Quarterly Procurement Performance Report**. Each has "Print / save as
   PDF" (browser print) and CSV download.

Dashboard and the **Board / CEO** page show plan progress: actual = share of the 13 Annex III milestones with an
actual date (value-weighted), against the share the schedule expects by today, by division/department. They also show
progress **by Time Schedule milestone** (counted by procurement, from the appointment of the Procurement Committee:
due / achieved / on time / late / overdue, and how many procurements stand at each stage) and which procurements were
**done within the Procurement Time Schedule** (contract signed by its schedule date; late; not done and overdue; not done
but still within schedule). The schedule is the one set when execution was authorised, else the approved plan dates;
"done" is `DONE_MILESTONE` in `server/src/progress.js`. Both are also reports.

Roles: `admin`, `requester` (department or sub-unit user), `dept_head` (authorises for the department and its sub
units), `procurement`, `management`, `executive` (Board/CEO, read-only).

Organisation: Division → Department → Sub unit (Admin → Divisions, departments & sub units).

## Rules encoded (`server/src/rules.js`)

All values LKR million, TCE incl. VAT. Defaults can be overridden in Admin → Limits.

- §2.9(1) committee level – GOSL: RPC ≤ 50, DPC/PPC ≤ 400, MPC ≤ 750, above that HLPC/SHLPC.
  Foreign funded: 100 / 800 / 1500.
- §2.9(2) Shopping caps per authority (CAO/AO/PD, RPC, DPC/PPC, MPC) by works/goods/services.
- §6.3 minimum bidding period – ICB/LIB 42 d; NCB/LNB 21 d (≥ 50 Mn) or 14 d; Shopping 7 d national /
  14 d international.
- Annex VIII / IX bidding weeks (max and compulsory) by value band.

Things to verify against the printed Manual before relying on them officially: the default lead times
used to draft milestone dates (planning defaults, not Manual values), how the "max/compulsory" weeks in
Annex VIII/IX are used in warnings, the Preparatory-plan selection rule (procurements starting by
31 March), and the exact column layout of each Annex report.

## Assumptions and limits

- Financial year = calendar year. A "plan cycle" is a base year plus the two following tentative years.
- Budget year of an item = cycle + year offset; availability = allocation − plan items (incl. VAT), worked out
  separately for CAPEX and OPEX allocations (each budget line is one or the other).
- Funding classes for the limits: LECO and GOSL use the GOSL tables; Foreign and Grant use the foreign-funded tables.
- Workflow reminders are in-app (dashboard, plan page); only TEC appointments and reminders are e-mailed. No SMS.
- Not included: e-mail notifications for the other workflow steps, e-signatures, attachments, consolidation across companies for the
  ministry, Chapters 5–8 (bidding documents, evaluation, contract management).
