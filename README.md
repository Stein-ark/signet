# Signet

Signet is an electronic-signing product for preparing documents, collecting verified
signatures, and producing sealed PDFs with an audit certificate.

## Local setup

Requirements: Node.js 20.9 or later and a MongoDB server for database-backed features.

```sh
npm install
npm run keys
npm run dev
```

`npm run keys` creates a private `.env.local` with new development-only secrets. It refuses
to overwrite an existing environment file. Keep `.env.local` private and generate separate
secrets for every deployment. The app's marketing page can be opened without MongoDB; database
features require a MongoDB instance at `mongodb://127.0.0.1:27017` or a `MONGODB_URI` you set
in `.env.local`.

For configuration options and storage/email providers, see [`.env.example`](./.env.example).
Use `npm run typecheck`, `npm test` and `npm run build` to validate changes.

## Project status

The landing page, owner registration and sign-in, protected agreement dashboard, encrypted
PDF draft upload, recipient editing, and signature-field placement are in place. Registration,
login, and draft workflows need a running MongoDB instance. Draft validation and sending,
invitation and one-time-code email delivery, recipient-only document access, field entry,
drawn signatures, consent, decline, reminders, audit review, approval, sealing, private sealed
downloads, and public seal verification are implemented. Production
email requires `EMAIL_DRIVER=smtp` or `EMAIL_DRIVER=resend` and provider credentials in the
private environment. The default console provider is development-only and prints verification
codes and signing links in the server log; it is rejected in production.

Owners can cancel an agreement that is out for signature. Expiry, automatic reminders and
recovery of interrupted completions run from `POST /api/cron/maintenance`, which a scheduler
should call every few minutes with `Authorization: Bearer $CRON_SECRET`. Distribution of the
sealed copy to signers and versioning (re-issuing a corrected agreement) remain to be
implemented in the sequence described in [`PLAN.md`](./PLAN.md).

## Deployment notes

Set `TRUST_PROXY_HOPS` to the number of reverse proxies in front of the app (1 for a typical
platform edge or load balancer). Client IPs recorded as evidence and used for rate limiting are
read from that position in `X-Forwarded-For`; with `0`, IP-based limits are skipped.

## Tests

`npm test` runs the unit tests and an end-to-end lifecycle test that drives the real route
handlers against an in-memory MongoDB replica set (downloaded on first run).
`npm run test:unit` skips the integration test.
