-- Hubnet receives this short client reference with every purchase request.
-- Preserve it on the two unresolved sample orders so they can be reconciled
-- in Hubnet even though no provider-generated transaction ID was returned.
update public.orders
set provider_transaction_id = left(delivery_reference, 12)
where id in (
  '03186080-c2fc-4ed3-b4ae-9d6cb8ae7f0e',
  'ab3c3c29-a324-49b1-bfe1-ccaafd8ad8bd'
)
  and delivery_provider = 'hubnet'
  and delivery_status = 'unknown'
  and provider_transaction_id is null
  and delivery_reference ~ '^DS[0-9A-Fa-f]{23}$';
