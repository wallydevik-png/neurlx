
create table if not exists public.advanced_risk_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  max_portfolio_heat_pct numeric not null default 6,
  max_correlation numeric not null default 0.75,
  max_var_pct numeric not null default 5,
  target_daily_vol_pct numeric not null default 1.5,
  kelly_fraction numeric not null default 0.25,
  max_sector_pct numeric not null default 40,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.advanced_risk_settings to authenticated;
grant all on public.advanced_risk_settings to service_role;
alter table public.advanced_risk_settings enable row level security;
create policy "advanced_risk_own_select" on public.advanced_risk_settings for select to authenticated using (auth.uid() = user_id);
create policy "advanced_risk_own_insert" on public.advanced_risk_settings for insert to authenticated with check (auth.uid() = user_id);
create policy "advanced_risk_own_update" on public.advanced_risk_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.risk_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  captured_at timestamptz not null default now(),
  equity numeric not null,
  portfolio_heat_pct numeric not null default 0,
  var_95_pct numeric not null default 0,
  cvar_95_pct numeric not null default 0,
  portfolio_vol_pct numeric not null default 0,
  max_correlation numeric not null default 0,
  open_positions int not null default 0,
  risk_score int not null default 0
);
grant select, insert on public.risk_snapshots to authenticated;
grant all on public.risk_snapshots to service_role;
alter table public.risk_snapshots enable row level security;
create policy "risk_snapshots_own_select" on public.risk_snapshots for select to authenticated using (auth.uid() = user_id);
create policy "risk_snapshots_own_insert" on public.risk_snapshots for insert to authenticated with check (auth.uid() = user_id);
create index if not exists risk_snapshots_user_time on public.risk_snapshots(user_id, captured_at desc);
