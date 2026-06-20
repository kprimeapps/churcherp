-- ChurchOS v2 — Complete Schema
-- Run this once on your Supabase project

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─── ORGANIZATIONS ────────────────────────────────────────────────────────────
create table if not exists organizations (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  sub_name      text,
  denomination  text,
  logo_url      text,
  org_type      text not null default 'congregation'
                  check (org_type in ('congregation','district','presbytery','national')),
  district_id   uuid references organizations(id),
  presbytery_id uuid references organizations(id),
  national_id   uuid references organizations(id),
  settings      jsonb not null default '{}',
  plan          text not null default 'free'
                  check (plan in ('free','starter','pro','enterprise')),
  currency      text not null default 'USD',
  qr_reset_code text not null default substr(encode(gen_random_bytes(3),'hex'),1,6),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ─── PROFILES ─────────────────────────────────────────────────────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid references organizations(id),
  first_name  text,
  last_name   text,
  phone       text,
  avatar_url  text,
  role        text not null default 'owner'
                check (role in ('owner','admin','staff','viewer',
                                'district_admin','presbytery_admin','national_admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ─── MEMBERS ──────────────────────────────────────────────────────────────────
create table if not exists members (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  first_name     text not null,
  last_name      text not null,
  phone          text,
  email          text,
  membership_no  text,
  gender         text check (gender in ('Male','Female','Other')),
  date_of_birth  date,
  date_joined    date,
  role           text default 'General',
  group_name     text,
  is_active      boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ─── ATTENDANCE ───────────────────────────────────────────────────────────────
create table if not exists attendance (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  member_id       uuid references members(id) on delete set null,
  guest_name      text,
  guest_phone     text,
  guest_role      text,
  service_date    date not null default current_date,
  service_type    text not null default 'Sunday Service',
  group_name      text,
  check_in_method text not null default 'manual'
                    check (check_in_method in ('manual','qr','import')),
  notes           text,
  created_at      timestamptz not null default now()
);

-- ─── QR REGISTRATIONS ─────────────────────────────────────────────────────────
create table if not exists qr_registrations (
  id             text primary key,
  org_id         uuid not null references organizations(id) on delete cascade,
  first_name     text not null,
  last_name      text,
  phone          text,
  membership_no  text,
  role           text default 'General',
  imported       boolean not null default false,
  created_at     timestamptz not null default now()
);

create unique index if not exists idx_qr_reg_dedup
  on qr_registrations (org_id, lower(trim(first_name)), trim(coalesce(phone,'')));

-- ─── GIVING ───────────────────────────────────────────────────────────────────
create table if not exists giving (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  member_id      uuid references members(id) on delete set null,
  member_name    text,
  amount         numeric(14,2) not null check (amount > 0),
  currency       text not null default 'USD',
  category       text not null default 'Tithe',
  payment_method text not null default 'Cash',
  given_date     date not null default current_date,
  notes          text,
  recorded_by    uuid references profiles(id),
  created_at     timestamptz not null default now()
);

-- ─── GROUPS ───────────────────────────────────────────────────────────────────
create table if not exists groups (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  name          text not null,
  description   text,
  meeting_days  int[],
  leader_id     uuid references members(id) on delete set null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ─── EVENTS ───────────────────────────────────────────────────────────────────
create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  title       text not null,
  description text,
  location    text,
  event_type  text not null default 'Service',
  start_date  timestamptz not null,
  end_date    timestamptz,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);

-- ─── VOLUNTEERS ───────────────────────────────────────────────────────────────
create table if not exists volunteers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  member_id   uuid references members(id) on delete cascade,
  department  text not null,
  role        text,
  is_active   boolean not null default true,
  joined_date date default current_date,
  created_at  timestamptz not null default now()
);

-- ─── VISITORS ─────────────────────────────────────────────────────────────────
create table if not exists visitors (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  first_name     text not null,
  last_name      text,
  phone          text,
  email          text,
  visit_date     date not null default current_date,
  how_heard      text,
  notes          text,
  followed_up    boolean not null default false,
  follow_up_date date,
  created_at     timestamptz not null default now()
);

-- ─── WELFARE ──────────────────────────────────────────────────────────────────
create table if not exists welfare (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  member_id    uuid references members(id) on delete set null,
  member_name  text,
  type         text not null,
  description  text,
  amount       numeric(14,2),
  currency     text default 'USD',
  welfare_date date not null default current_date,
  status       text not null default 'pending'
                 check (status in ('pending','approved','disbursed','closed')),
  notes        text,
  created_at   timestamptz not null default now()
);

-- ─── EDUCATION ────────────────────────────────────────────────────────────────
create table if not exists education (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  member_id   uuid references members(id) on delete set null,
  member_name text,
  program     text not null,
  institution text,
  year        text,
  status      text not null default 'enrolled',
  notes       text,
  created_at  timestamptz not null default now()
);

-- ─── MISSIONS ─────────────────────────────────────────────────────────────────
create table if not exists missions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  title            text not null,
  missionary_name  text,
  location         text,
  start_date       date,
  end_date         date,
  budget           numeric(14,2),
  currency         text default 'USD',
  status           text not null default 'active',
  notes            text,
  created_at       timestamptz not null default now()
);

-- ─── SCHOLARSHIPS ─────────────────────────────────────────────────────────────
create table if not exists scholarships (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  member_id      uuid references members(id) on delete set null,
  member_name    text,
  amount         numeric(14,2),
  currency       text default 'USD',
  institution    text,
  academic_year  text,
  field_of_study text,
  status         text not null default 'active',
  notes          text,
  created_at     timestamptz not null default now()
);

-- ─── COMMUNICATIONS ───────────────────────────────────────────────────────────
create table if not exists communications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  title      text not null,
  body       text,
  type       text not null default 'announcement',
  audience   text not null default 'all',
  sent_at    timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- ─── FAMILY LIFE ──────────────────────────────────────────────────────────────
create table if not exists family_life (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  type        text not null,
  member_id   uuid references members(id) on delete set null,
  member_name text,
  description text,
  event_date  date not null,
  notes       text,
  created_at  timestamptz not null default now()
);

-- ─── FINANCE: ACCOUNTS ────────────────────────────────────────────────────────
create table if not exists accounts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  code         text,
  name         text not null,
  account_type text not null
                 check (account_type in ('asset','liability','equity','income','expense')),
  balance      numeric(14,2) not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ─── FINANCE: TRANSACTIONS ────────────────────────────────────────────────────
create table if not exists transactions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  debit_account_id  uuid not null references accounts(id),
  credit_account_id uuid not null references accounts(id),
  amount            numeric(14,2) not null check (amount > 0),
  description       text not null,
  category          text,
  transaction_date  date not null default current_date,
  reference_no      text,
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now()
);

-- ─── FINANCE: BUDGETS ─────────────────────────────────────────────────────────
create table if not exists budgets (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null,
  fiscal_year  text not null,
  total_amount numeric(14,2) not null default 0,
  currency     text not null default 'USD',
  status       text not null default 'draft'
                 check (status in ('draft','approved','active','closed')),
  created_at   timestamptz not null default now()
);

create table if not exists budget_lines (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references budgets(id) on delete cascade,
  org_id      uuid not null references organizations(id),
  category    text not null,
  description text,
  amount      numeric(14,2) not null default 0,
  spent       numeric(14,2) not null default 0,
  created_at  timestamptz not null default now()
);

-- ─── FINANCE: PAYROLL ─────────────────────────────────────────────────────────
create table if not exists payroll (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  member_id    uuid references members(id) on delete set null,
  member_name  text not null,
  staff_role   text,
  gross_amount numeric(14,2) not null,
  deductions   numeric(14,2) not null default 0,
  net_amount   numeric(14,2) generated always as (gross_amount - deductions) stored,
  currency     text not null default 'USD',
  pay_period   text not null,
  payment_date date,
  status       text not null default 'pending'
                 check (status in ('pending','paid','cancelled')),
  notes        text,
  created_at   timestamptz not null default now()
);

-- ─── EXPENSES ─────────────────────────────────────────────────────────────────
create table if not exists expenses (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  title        text not null,
  amount       numeric(14,2) not null check (amount > 0),
  currency     text not null default 'USD',
  category     text not null default 'General',
  expense_date date not null default current_date,
  vendor       text,
  receipt_url  text,
  status       text not null default 'pending'
                 check (status in ('pending','approved','paid','rejected')),
  recorded_by  uuid references profiles(id),
  notes        text,
  created_at   timestamptz not null default now()
);

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
create index if not exists idx_members_org        on members(org_id, is_active);
create index if not exists idx_attendance_org     on attendance(org_id, service_date desc);
create index if not exists idx_attendance_member  on attendance(member_id);
create index if not exists idx_giving_org         on giving(org_id, given_date desc);
create index if not exists idx_transactions_org   on transactions(org_id, transaction_date desc);
create index if not exists idx_qr_reg_org         on qr_registrations(org_id);
create index if not exists idx_profiles_org       on profiles(org_id);
create index if not exists idx_expenses_org       on expenses(org_id, expense_date desc);
create index if not exists idx_visitors_org       on visitors(org_id, visit_date desc);
