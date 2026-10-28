create table if not exists public.bundle_categories (
  id uuid primary key default gen_random_uuid(),
  network text not null references public.networks(id) on update cascade on delete restrict,
  name text not null,
  description text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (network, name)
);

create table if not exists public.bundle_subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.bundle_categories(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (category_id, name)
);

alter table public.bundle_categories enable row level security;
alter table public.bundle_subcategories enable row level security;
grant select on public.bundle_categories, public.bundle_subcategories to anon, authenticated;
grant insert, update, delete on public.bundle_categories, public.bundle_subcategories to authenticated;
create policy "Read active bundle categories" on public.bundle_categories for select
  using (is_active or public.is_admin());
create policy "Admins manage bundle categories" on public.bundle_categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "Read active bundle subcategories" on public.bundle_subcategories for select
  using (is_active or public.is_admin());
create policy "Admins manage bundle subcategories" on public.bundle_subcategories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Preserve existing plan groups as categories and give legacy General plans
-- a carrier-specific category so existing plans remain visible and editable.
insert into public.bundle_categories(network, name, description)
select distinct b.network,
  case when b.category = 'General' then
    case b.network when 'AT' then 'AIRTEL-TIGO DATA' when 'MTN' then 'MTN DATA' else 'TELECEL DATA' end
  else b.category end,
  case when b.category = 'General' then 'Data bundles for ' || b.network else '' end
from public.bundles b
on conflict (network, name) do nothing;

insert into public.bundle_categories(network, name, description)
select n.id,
  case n.id when 'AT' then 'AIRTEL-TIGO DATA' when 'MTN' then 'MTN DATA' else 'TELECEL DATA' end,
  'Data bundles for ' || n.name
from public.networks n
on conflict (network, name) do nothing;

update public.bundles b
set category = case b.network when 'AT' then 'AIRTEL-TIGO DATA' when 'MTN' then 'MTN DATA' else 'TELECEL DATA' end
where b.category = 'General';

insert into public.bundle_subcategories(category_id, name)
select distinct c.id, b.subcategory
from public.bundles b
join public.bundle_categories c on c.network = b.network and c.name = b.category
where nullif(trim(b.subcategory), '') is not null
on conflict (category_id, name) do nothing;

create or replace function public.propagate_bundle_category_rename()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.name is distinct from new.name or old.network is distinct from new.network then
    update public.bundles set network = new.network, category = new.name
      where network = old.network and category = old.name;
  end if;
  return new;
end;
$$;
drop trigger if exists propagate_bundle_category_rename on public.bundle_categories;
create trigger propagate_bundle_category_rename after update of name, network on public.bundle_categories
for each row execute function public.propagate_bundle_category_rename();

create or replace function public.reject_orders_for_inactive_bundle_category()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.bundles b
    join public.bundle_categories c on c.network = b.network and c.name = b.category
    where b.id = new.bundle_id and b.is_active and c.is_active
  ) then
    raise exception 'This data plan category is not currently available';
  end if;
  return new;
end;
$$;

drop trigger if exists ensure_active_bundle_category on public.orders;
create trigger ensure_active_bundle_category before insert on public.orders
for each row execute function public.reject_orders_for_inactive_bundle_category();
