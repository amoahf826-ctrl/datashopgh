-- Extra catalogue fields used by the grouped admin data-plan editor.
alter table public.bundles
  add column if not exists category text not null default 'General',
  add column if not exists subcategory text not null default '',
  add column if not exists owner_cost numeric(10,2) not null default 0 check (owner_cost >= 0);
