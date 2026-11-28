# CheapDataBundle Agent Partner API

This guide describes the partner endpoint implemented by CheapDataBundle. It is based on the current Supabase Edge Function implementation. Provider routes are selected by the server and credentials are never sent by the caller.

## Base URL

```text
https://<project-ref>.supabase.co/functions/v1/wallet-bundle-purchase
```

## Authentication

Create or revoke a key from **Agent Dashboard → Profile**. Send it in the `x-agent-api-key` header. Keys currently have the form `cdb_live_` followed by 64 hexadecimal characters.

```http
x-agent-api-key: cdb_live_<secret>
Accept: application/json
Content-Type: application/json
```

Keep the key secret. It authorizes spending from the agent's wallet. The server stores only a hash of the key and rejects revoked keys or inactive agent accounts. Do not put the key in browser code or public repositories.

Authenticated agent sessions may also call `POST` with `Authorization: Bearer <session-token>`. The `GET` partner actions require an agent API key.

## List available plans

```http
GET /functions/v1/wallet-bundle-purchase?action=plans
x-agent-api-key: cdb_live_<secret>
```

Example response:

```json
{
  "success": true,
  "currency": "GHS",
  "plans": [
    {
      "id": "<bundle-id>",
      "network": "Telecel",
      "category": "Data",
      "subcategory": "Standard",
      "size": "2GB",
      "validity": "<validity>",
      "price": 9.0,
      "wallet_cost": 8.2
    }
  ]
}
```

`price` is the agent storefront/customer price. `wallet_cost` is the amount charged to the agent wallet. Only active plans on active networks are returned.

## Place a wallet order

```http
POST /functions/v1/wallet-bundle-purchase
x-agent-api-key: cdb_live_<secret>
Content-Type: application/json
Accept: application/json
```

```json
{
  "bundle_id": "<bundle-id-from-plans>",
  "recipient_phone": "0241234567",
  "idempotency_key": "<new-uuid-per-customer-order>"
}
```

Requirements:

- `bundle_id`: string identifying an active plan returned by `action=plans`, at most 100 characters.
- `recipient_phone`: Ghana local format, exactly `0` plus nine digits.
- `idempotency_key`: 36-character UUID-shaped value. Reuse the same key only when retrying the same logical request; use a new key for a new order. It is used inside CheapDataBundle to avoid duplicate wallet orders and is not forwarded to DataHub or Hubnet.

Successful requests return JSON with `success`, order fields, and `delivery_status`. A duplicate idempotency key returns the existing order with `duplicate: true`. Delivery may be `processing`, `delivered`, or `failed`; failed wallet purchases are refunded by the server when its refund operation succeeds. Example shape (some fields are omitted):

```json
{
  "success": true,
  "order_id": "<order-uuid>",
  "bundle_id": "<bundle-id>",
  "recipient_phone": "0241234567",
  "delivery_status": "processing",
  "wallet_balance": 42.5,
  "message": "The active provider accepted the order and is processing it."
}
```

An insufficient wallet balance returns HTTP `409`. Invalid input or an unavailable plan returns `400`; missing or invalid credentials return `401`; inactive accounts return `403`; configuration or temporary service failures may return `5xx`. Error bodies use `{ "error": "..." }`.

## Check an order

```http
GET /functions/v1/wallet-bundle-purchase?action=status&reference=<order-reference>
x-agent-api-key: cdb_live_<secret>
```

`reference` may be the order UUID, CheapDataBundle delivery reference, or saved provider transaction reference. The endpoint only returns orders owned by the authenticated agent/API key. A matching order returns `{ "success": true, "order": { ... } }`; otherwise it returns `404`.

## Provider routing and formats

The caller submits a CheapDataBundle bundle ID; the server looks up its network/size and applies the configured provider assignment or fallback. Do not send provider credentials or provider-specific endpoint names from the client.

- **DataHub:** `POST https://user.datahubgh.com/api/external/data-purchase`. The server sends `networkKey`, `recipient`, and `capacity` (string in GB units), with `X-API-Key`, JSON/Accept headers, and the configured storefront `Origin`/`Referer`.
- **Hubnet:** `POST https://hubnet.app/live/api/context/business/transaction/<network-route>`. The server sends `phone`, `volume` (string in MB), a short `reference`, and a `webhook` URL. Headers include `token: Bearer <server-secret>`, JSON content type, and Accept.
- **Tigo/AirtelTigo:** stored as network `AT`. iShare uses DataHub `AT_PREMIUM` or Hubnet `at-new-transaction`; Big Time uses DataHub `AT_BIGTIME` or Hubnet `big-time-new-transaction`.
- **Telecel:** DataHub `TELECEL` or Hubnet `telecel-new-transaction`.

Provider status synchronization is server-to-server. DataHub lookups use the transaction identifier returned by DataHub (`orderNumber` for numeric IDs, otherwise `reference`). Hubnet checks its transaction-status endpoint by reference. The partner caller should use this API's `action=status` endpoint rather than calling provider status APIs directly.

## Operational notes

- Live sales must be enabled and the selected provider must be enabled/configured.
- MTN orders may require successful number verification before the wallet is charged.
- Retry the same request with the same idempotency key if the client did not receive a response; check status if the outcome is unclear.
- Never interpret a transport timeout as permission to submit the same purchase with a new key. Check the order first.

## Sanitized curl examples

```sh
curl 'https://<project-ref>.supabase.co/functions/v1/wallet-bundle-purchase?action=plans' \
  -H 'x-agent-api-key: cdb_live_<secret>' \
  -H 'Accept: application/json'
```

```sh
curl 'https://<project-ref>.supabase.co/functions/v1/wallet-bundle-purchase' \
  -H 'x-agent-api-key: cdb_live_<secret>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data '{"bundle_id":"<bundle-id-from-plans>","recipient_phone":"0241234567","idempotency_key":"<uuid>"}'
```

```sh
curl 'https://<project-ref>.supabase.co/functions/v1/wallet-bundle-purchase?action=status&reference=<order-reference>' \
  -H 'x-agent-api-key: cdb_live_<secret>' \
  -H 'Accept: application/json'
```
