-- ChurchOS v2 — Migration 004: payroll Ghana model, members extensions, reconciliation

-- ─── MEMBERS: employment + sacraments ────────────────────────────────────────
alter table members
  add column if not exists occupation       text,
  add column if not exists employer         text,
  add column if not exists employment_type  text,   -- employed, self-employed, student, retired, unemployed
  -- Sacraments
  add column if not exists baptised         boolean default false,
  add column if not exists baptism_date     date,
  add column if not exists baptism_place    text,
  add column if not exists confirmed        boolean default false,
  add column if not exists confirmation_date date,
  add column if not exists confirmation_place text;

-- ─── PAYROLL: rebuild with Ghana model ───────────────────────────────────────
drop table if exists payroll cascade;

create table payroll (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  member_id        uuid references members(id) on delete set null,
  member_name      text not null,
  staff_role       text,
  -- Salary components
  basic_salary     numeric(14,2) not null default 0,
  allowances       jsonb not null default '[]',   -- [{name, amount}]
  gross_salary     numeric(14,2) not null default 0,
  -- Statutory deductions (Ghana)
  ssnit_employee   numeric(14,2) not null default 0,  -- 5.5% of basic
  ssnit_employer   numeric(14,2) not null default 0,  -- 13% of basic
  tier2            numeric(14,2) not null default 0,  -- 5% of basic (employer)
  paye             numeric(14,2) not null default 0,
  -- Other deductions
  other_deductions jsonb not null default '[]',   -- [{name, amount}]
  total_deductions numeric(14,2) not null default 0,
  net_salary       numeric(14,2) not null default 0,
  -- Bank details
  bank_name        text,
  bank_branch      text,
  bank_account_no  text,
  bank_account_name text,
  -- Period
  currency         text not null default 'GHS',
  pay_period       text not null,
  payment_date     date,
  status           text not null default 'pending'
                     check (status in ('pending','paid','cancelled')),
  notes            text,
  created_at       timestamptz not null default now()
);

alter table payroll enable row level security;
create policy "rls_payroll" on payroll
  for all using (org_id = auth_org_id());

-- ─── BANK RECONCILIATION ─────────────────────────────────────────────────────
create table if not exists reconciliations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  period           text not null,           -- e.g. "2025-06"
  account_id       uuid references accounts(id),
  statement_balance numeric(14,2) not null default 0,
  book_balance     numeric(14,2) not null default 0,
  difference       numeric(14,2) generated always as (statement_balance - book_balance) stored,
  status           text not null default 'open' check (status in ('open','reconciled')),
  notes            text,
  created_at       timestamptz not null default now()
);

create table if not exists reconciliation_items (
  id                 uuid primary key default gen_random_uuid(),
  reconciliation_id  uuid not null references reconciliations(id) on delete cascade,
  org_id             uuid not null references organizations(id),
  transaction_id     uuid references transactions(id) on delete set null,
  description        text not null,
  amount             numeric(14,2) not null,
  item_date          date,
  item_type          text not null default 'book'  -- 'book' | 'statement'
                       check (item_type in ('book','statement')),
  cleared            boolean not null default false,
  created_at         timestamptz not null default now()
);

alter table reconciliations      enable row level security;
alter table reconciliation_items enable row level security;

create policy "rls_reconciliations"      on reconciliations      for all using (org_id = auth_org_id());
create policy "rls_reconciliation_items" on reconciliation_items for all using (org_id = auth_org_id());
