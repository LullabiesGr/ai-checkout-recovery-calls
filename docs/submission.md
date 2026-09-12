# CartEcho — App Store submission handoff

## Delivered in the application

- `/privacy`: public privacy policy.
- `/support`: public support form; submissions are stored in the app database and appear in **Privacy & public support** for the platform administrator.
- `/documentation`: public setup, pricing and workflow instructions.
- `/webhooks/privacy`: authenticated Shopify compliance webhook endpoint for `customers/data_request`, `customers/redact`, `shop/redact`.
- `/app/privacy`: shop-scoped privacy requests and expiring customer exports.
- `/app/admin/privacy`: cross-store operator queue and external processor erasure worklists, visible only to the configured platform admin shop.

Use the deployed app origin `https://checkout-call-recovery-ai.onrender.com` for these public URLs. A GitHub merge updates the web application only if its host auto-deploys; it does **not** release Shopify TOML configuration.

## Release the Shopify configuration before submission

From the repository, using an authenticated Shopify CLI session for the existing CartEcho app:

```sh
shopify app config validate --json
shopify app deploy
```

The app identity in `shopify.app.toml` is CartEcho, client ID `b14c2c0645270d506c4bbc827807a208`. Verify this identity before confirming a CLI release. This releases the three compliance subscriptions and removes the unused `write_products` permission. Keep the deployment's `SCOPES` environment variable aligned with the TOML list:

```text
read_orders,read_checkouts,read_discounts,write_discounts,read_customers
```

Code and webhook configuration target Shopify API 2026-04. Remove stale deployment overrides of `SHOPIFY_API_VERSION` or `SHOPIFY_ADMIN_API_VERSION` if they still select 2025-07.

Web host startup must run `npm run setup` before `npm run start` (the existing `docker-start` does). The additive privacy migration creates server-only tables with RLS and revokes browser-role access to new and existing Prisma models. The runtime database role must be the table owner or an appropriately privileged server role; browser roles are intentionally blocked. Do not run a reset or reseed on production.

## Privacy operations

Webhook receipt verifies Shopify's HMAC, validates the signed shop domain and persists the request before returning 200. It does not wait for external deletion. The existing authenticated `/api/cron` processes pending requests. Keep the existing scheduler running and ensure `CRON_TOKEN` and `RUN_CALLS_SECRET` are set: the workers now fail closed if their secret is missing. The operator can also process the queue from the app.

Requests are serialized per shop to avoid exporting data while an erasure is processing. Exports expire after 30 days and are invalidated when erasure occurs. Uninstall immediately disables automation and removes sessions, retaining provider identifiers until `shop/redact` cleanup. A stale shop-redact is skipped if the app has been installed again.

The erasure worker deletes matching local checkouts, orders, calls and related charges; requests deletion of known Vapi calls; and deletes matching shop-scoped `vapi_call_summaries` rows. Store erasure additionally deletes billing, settings, coupon-redemption and Supabase support records. Failures retain identifiers and remain retryable.

**External processor review is mandatory when a worklist exists.** Confirm deletion/retention handling for SMS logs, support messages mentioning the customer, raw Vapi webhook or Edge Function tables, AI logs, backups and any separate automations. The codebase does not contain those external schemas or provider retention settings. `REVIEW_REQUIRED` is not a completed erasure; mark it complete only after verifying those remaining tasks. This is an operator workflow, not a claim that all external copies are automatically deleted.

Only return exports to a requester after verifying identity. The generated file covers directly accessible CartEcho records. Check whether additional processor/support records must be included. No export is emailed automatically. Monitor requests and complete them within Shopify's deadline (normally 30 days).

## App listing and protected customer data

Set the listing name to **CartEcho** and use actual current screenshots. Pricing:

| Plan | Price per 30-day cycle | Included attempts |
|---|---:|---:|
| Free | €0 | 10 |
| Starter | €19 | 30 |
| Pro | €49 | 120 |
| Scale | €99 | 400 |

Additional-charge description: **Optional one-time purchase: 25 extra call attempts for €20 (€0.80 per attempt). SMS included. Unused extra attempts carry over. No automatic overage charges.**

One outbound call is one attempt whether or not the customer answers. Do not list PAYG, a spending cap, SMS pricing or talk-time pricing.

Request only the protected customer fields used by the app. Explain their purpose accurately:

- Name: addressing the shopper in the recovery conversation.
- Phone: placing the permitted recovery call and sending its related SMS.
- Email: identifying the customer when linking checkouts and orders and processing privacy requests.
- Checkout/order records: determining abandonment, cart context and confirmed order recovery.
- Discounts: creating the merchant-configured recovery offer.

The Shopify **protected customer data approval** and App Store listing are dashboard tasks; repository changes do not grant that approval. Do not attest to security controls or third-party retention settings that have not been checked. The privacy page must also be checked against the operator's actual legal identity and provider contracts before it is submitted.

## Reviewer workflow

Provide a short screencast showing installation, Automation settings, a permitted test checkout, the resulting call/transcript, recovered-order attribution and Billing. Give reviewers explicit instructions to use a phone number they control and to avoid contacting real shoppers. If a test account is necessary, provide it privately in Shopify's testing-instructions field, never in the repository.

Verify on a fresh development store:

1. Install and re-open the embedded app without manual database setup.
2. Start with automation disabled; confirm setup, permitted contact and a controlled test call.
3. Approve/decline a plan change and an extra-attempt purchase using Shopify test billing; no approval must grant zero extra attempts and a repeated return must not credit twice.
4. Verify protected data access, SMS, written conversation and actual matched-order recovery.
5. Deliver all three compliance topics using the Shopify CLI/dashboard. Invalid HMAC must return 401; a valid replay must not duplicate the request.
6. Download the requested customer data and erase only a disposable test customer. Verify Vapi/Supabase/other processors as well as the app database. Never test erasure with real customer records.
7. Uninstall; verify that queued calls stop. Verify shop redaction against disposable test-store data and reinstall afterwards.
8. Open public privacy/support/documentation URLs outside Shopify; submit a test support message and confirm it reaches the operator inbox.

## Local verification

```sh
npm run setup          # against a dedicated test database only
npm run typecheck
npm run build
node --test tests/billing-prepaid.test.cjs tests/privacy.test.cjs
```

Tests cover billing quota logic, purchase idempotency, privacy matching, cross-shop isolation, replay handling, processor failures, reinstall protection and the real installed Shopify SDK's HMAC verifier. Database tests use mocked repositories; they do not prove production schema permissions, real PostgreSQL lock behavior or third-party deletion.
