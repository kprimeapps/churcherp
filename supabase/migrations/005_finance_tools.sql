-- ChurchOS v2 — Migration 005: rich reconciliation + budget tools (JSON state)

-- Per-account, per-period bank reconciliation snapshots
create table if not exists recon_snapshots (
  org_id     uuid not null references organizations(id) on delete cascade,
  account    text not null,
  period     text not null,                    -- "YYYY-MM"
  state      jsonb not null default '{}',      -- {bankItems, bookItems, matches, adjustments, closingBal}
  updated_at timestamptz not null default now(),
  primary key (org_id, account, period)
);

-- One budget plan per org (holds receipts[] / payments[] with bYYYY budget keys)
create table if not exists budget_plans (
  org_id     uuid primary key references organizations(id) on delete cascade,
  plan       jsonb not null default '{}',      -- {receipts:[...], payments:[...]}
  updated_at timestamptz not null default now()
);

alter table recon_snapshots enable row level security;
alter table budget_plans    enable row level security;

create policy "rls_recon_snapshots" on recon_snapshots for all using (org_id = auth_org_id());
create policy "rls_budget_plans"    on budget_plans    for all using (org_id = auth_org_id());
