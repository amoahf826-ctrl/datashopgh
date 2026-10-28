# DataShopGH

A responsive Ghana data bundle storefront built with React, TypeScript, Tailwind CSS, and Supabase Auth/Postgres. Prices are shown in GHS. The interface and database seed data are clearly marked as demonstration data. Test mode does not take payments, credit wallets, or deliver mobile data.

## Run locally

1. Install Node.js 20 or later.
2. Run `npm install` and `npm run dev` in this directory.
3. Open the local Vite URL. Without Supabase credentials, login uses a temporary browser session so you can preview the screens; it is not secure or persistent.

## Verify changes

Run `npm run build` to type-check the TypeScript and produce a production bundle. There is no separate automated test suite in this milestone. With Supabase configured, verify signup/email confirmation, login/logout, catalogue loading, and the pending demo order flow using an account you control. For database authorization checks, use Supabase's SQL editor with separate customer accounts and confirm each account can only select its own profile, wallet, orders, deposits, and ledger rows; also verify that customer writes to wallets, order status, deposits, and ledger are denied. Do not use a real payment or data-delivery transaction as a test.

## Configure Supabase

1. Create a Supabase project and copy its Project URL and publishable/anon key.
2. Copy `.env.example` to `.env.local`, then set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon key is intended for browser use; never put a service-role key in a `VITE_` variable.
3. Apply the SQL migrations in order (`202610180001_initial.sql`, `202610180002_admin_dashboard.sql`, then the remaining numbered migration files, including `202610210001_agent_dashboard.sql` and `202610280001_agent_portal_tools.sql`) in the Supabase SQL editor, or use the Supabase CLI with `supabase db push` after linking the project. Public updates are admin-managed and scheduled, with row-level security and a public image bucket. Wallet adjustments use a role-checked transactional RPC; wallet audit snapshots preserve before/after balances and notes. Super-agent assignments and plan overrides are admin-managed, audited, and stored separately from customer accounts and standard bundle prices. MTN AFA plans and authenticated customer requests are also admin-managed; requests are test records and do not submit an MTN registration or charge a payment method. Admin operations add agent controls, statistics, debtor review, preview-only SMS logs, provider metadata, and maintenance settings. SMS is not sent and provider secrets are not stored in the browser.
4. Enable email/password sign-in under Supabase Authentication. Configure the production site URL and allowed redirect URLs before publishing. Email confirmation should be configured for the intended launch policy.
5. Register your own account. To establish the first administrator, run a one-time SQL editor command using the exact account email:

   ```sql
   begin;
   alter table public.profiles disable trigger protect_profile_role;
   update public.profiles set role = 'admin' where email = 'you@example.com';
   alter table public.profiles enable trigger protect_profile_role;
   commit;
   ```

   Run this only in the trusted Supabase SQL Editor, replacing the email with your registered address. The transaction temporarily disables the role-protection trigger only for this one-time bootstrap and re-enables it before commit. Confirm the update matched your account. There is no public admin promotion flow. Never expose the service-role key to the browser. Admin pages and server-side admin operations should call `public.is_admin()` / enforce the role in trusted server code.

The migrations create customer-isolated RLS policies, seeded demonstration networks/bundles, a protected profile role, customer wallets, deposits, orders, an append-oriented financial ledger, public updates, MTN AFA plans and requests, admin operation records, and audit records. The `create_demo_order` RPC fetches the active price from the database and writes a pending demo order plus audit event. It never charges a wallet or delivers data. Browser users cannot insert/update financial records directly.

## Payments and delivery

The storefront supports a staged live bundle checkout path. Live checkout is disabled by default. It initializes Paystack from a Supabase Edge Function, verifies the signed `charge.success` event against Paystack's transaction verification endpoint, checks the authoritative GHS amount, and only then submits the order to Hubnet. A verified Hubnet status callback is required before an order is marked successful. Wallet deposits, MTN AFA registration, bulk SMS, and other preview-only admin actions are not part of live bundle checkout.

## Prepare live bundle checkout

1. Apply `supabase/migrations/202610180010_live_sales.sql` after the prior migrations.
2. Add `PAYSTACK_SECRET_KEY` using the live secret key in Supabase Edge Function secrets. The checkout function rejects test keys. Also set `APP_BASE_URL` to the production website origin, such as `https://your-store.example`; never put provider secrets in a `VITE_` variable or the browser.
3. Keep `HUBNET_API_BASE_URL` set to `https://console.hubnet.app` and `HUBNET_BEARER_TOKEN` in Supabase secrets.
4. Deploy `paystack-checkout`, `paystack-webhook`, `hubnet-webhook`, and the updated `hubnet-readonly` Edge Functions. `paystack-webhook` and `hubnet-webhook` must have gateway JWT verification disabled; they validate the Paystack signature or verify the Hubnet status server-to-server themselves.
5. Set the Paystack dashboard webhook URL to `https://<project-ref>.supabase.co/functions/v1/paystack-webhook`.
6. In Admin → Data Plans, set final reviewed prices and mark only approved, deliverable plans as non-demonstration plans. Seed plans are deliberately demonstration-only, and checkout rejects them.
7. Keep `storefront_live_sales.enabled` false until secrets, function deployments, webhook URL, and live catalogue have been reviewed. Enabling it exposes live checkout; customers can then make real Paystack payments and Hubnet orders may be submitted. Set it in the SQL editor only after that review:

```sql
update public.platform_settings
set value = jsonb_set(value, '{enabled}', 'true'::jsonb), updated_at = now()
where key = 'storefront_live_sales';
```

To return to preview mode, set `enabled` to `false`. If Hubnet times out after accepting an order, the app preserves an unknown/in-progress state rather than retrying automatically, to avoid duplicate delivery; reconcile that order with Hubnet before taking further action.

## Admin access

The admin console reads the role from the protected profile row, and every catalogue edit or record query is also enforced by database RLS. Administrators can manage network and bundle availability and prices, create MTN AFA plans, review customer AFA requests, manage agent accounts, inspect statistics/debtors, save SMS previews, maintain provider metadata, and set storefront maintenance notices. Customers can view the status of their own AFA requests. AFA requests are test-mode records only; they do not trigger payment or MTN registration. SMS previews are not delivered; API provider records contain no credentials and do not enable live calls. Catalogue, deposit, wallet adjustment, AFA plan, and AFA request status changes write audit events. Admin access is controlled by the profile role and should only be assigned by a trusted operator through the database.

The `hubnet-readonly` Supabase Edge Function provides an admin-only balance check by calling `GET /live/api/context/business/transaction/check_balance`. The `datahub-readonly` function verifies the GhanaDataHub API key by reading its balance and network list; it does not submit orders or route fulfillment. Store `GHANADATAHUB_API_KEY` in Supabase Edge Function secrets and deploy `datahub-readonly` before using Admin → API Providers → Verify DataHub API. The live bundle fulfillment path remains Hubnet until a separate DataHub order-routing and status-reconciliation integration is implemented and reviewed. Keep provider and payment credentials in Supabase function secrets, never in browser variables or source control.

## Build and publish

Run `npm run build` to produce `dist/`. Publish the repository to your hosting provider (for example Vercel or Netlify), set the two public Supabase environment variables in its project settings, and deploy. Configure the matching production URL in Supabase Auth. Keep live bundle checkout disabled until the secrets, functions, Paystack webhook, and approved non-demo catalogue are configured.
