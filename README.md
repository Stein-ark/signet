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
Use `npm run typecheck` and `npm run build` to validate changes.

## Project status

The current implementation includes the security, storage, authentication, audit, and PDF
building blocks. The user-facing application and API lifecycle are being built in the sequence
described in [`PLAN.md`](./PLAN.md).
