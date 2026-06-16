# Garden Secure Beta Launch Checklist

## Environment and Secrets
- Set `NODE_ENV=production`.
- Set a strong `WEBHOOK_SECRET` (do not use default).
- Set `DATABASE_URL` to production Postgres.
- Set `PGSSL=1` with trusted CA in production deployments.
- Set `ENABLE_DEV_TOOLS=0`.

## Data and Schema
- Run `npm run migrate:commerce` before first deploy.
- Verify auth and commerce tables exist in production DB.
- Confirm a rollback snapshot/backup exists.

## Security Verification
- Public signup only creates shopper users.
- `/api/orders/:id` requires ownership/admin/vendor/assigned-driver access.
- `/api/payments/initiate` enforces order ownership.
- Dev endpoints are blocked in production.
- Request body size limits return `413` for oversized payloads.

## Functional QA
- Shopper can sign up, sign in, edit profile, and change password.
- Shopper can place order and retrieve only their own orders.
- Shopper can submit vendor application.
- Admin can approve vendor application and provision linked vendor account.
- Vendor can edit store profile and account profile.
- Webhook duplicate events return `duplicate: true` and do not re-process.

## Release Gates
- Run `npm test`.
- Run `npm run dev` smoke test in staging-like environment.
- Verify logs contain startup success and no auth DB init errors.
- Confirm payment/webhook paths with staging credentials before go-live.
