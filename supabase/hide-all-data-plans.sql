-- One-time action: hide all existing data plans without deleting them.
-- Run this in the Supabase SQL Editor for the production project.
update public.bundles
set is_active = false
where is_active is distinct from false
returning id, network, size, is_active;
