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

Rule unit tests: `cd server && npm test`.

## Workflow

1. **Request** – a department user creates a request (category, cost excl./incl. VAT, funding, required
   date, plan cycle and year) and submits it.
2. **Authorise** – the department head authorises, returns (with comment) or rejects it.
3. **Procurement inbox** – the procurement unit assigns method, bidding procedure, prequalification,
   committee level, procurement start and expected delivery. Live checks against the Manual appear as
   warnings; a milestone schedule (Annex III) is drafted from the dates.
4. **Plan** – items form the annual plan (year 1) and tentative plans (years 2–3) of a cycle. The
   procurement unit submits it; management approves or returns it with comments; an approved plan is
   frozen.
5. **Revisions** – a frozen plan can only change through a bi-annual or urgent revision (add / modify /
   cancel). Management approval applies the changes atomically, bumps the plan version and stores a
   snapshot. Direct edits to a submitted/approved/frozen plan are rejected with HTTP 409.
6. **Execution** – the procurement unit records revised and actual milestone dates, supplier and award
   value. Overdue milestones surface on the dashboard.
7. **Reports** – MPP (Annex I), APPP (Annex II), DAPP (Annex III, Schedule/Revised/Actual rows),
   Preparatory plan (Annex VI), category-wise, department × category, method and committee summaries,
   budget availability and the **Quarterly Procurement Performance Report**. Each has "Print / save as
   PDF" (browser print) and CSV download.

Roles: `admin`, `requester` (department user), `dept_head`, `procurement`, `management`.

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
- Budget year of an item = cycle + year offset; availability = allocation − plan items (incl. VAT).
- Not included: notifications, e-signatures, attachments, consolidation across companies for the
  ministry, Chapters 5–8 (bidding documents, evaluation, contract management).
