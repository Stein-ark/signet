# Signet: Build Plan

Signet is a trust critical e signing product. An owner uploads a PDF, places fields, invites
recipients by email, each recipient proves who they are and signs, and the result is a sealed,
tamper evident PDF with an audit certificate.

## 1. Data model (MongoDB)

Five collections. Recipients and fields are embedded inside the envelope document so that a
single indexed read returns the whole signing context (no N+1), with a strict server side
projection layer that decides what each caller is allowed to see.

### users
| field | type | notes |
| --- | --- | --- |
| _id | ObjectId | |
| email | string | lowercased, unique index |
| name | string | |
| passwordHash | string | scrypt, `scrypt$N$r$p$salt$hash` |
| createdAt / updatedAt | Date | |
| failedLoginCount | number | brute force damping |
| lockedUntil | Date or null | |

Indexes: `{ email: 1 }` unique.

### sessions
Used for both owner sessions and post OTP signing sessions.

| field | type | notes |
| --- | --- | --- |
| _id | ObjectId | |
| kind | 'owner' or 'signing' | single purpose, never interchangeable |
| tokenHash | string | sha256 of a 32 byte random token, the raw token only ever lives in the cookie |
| csrfToken | string | double submit CSRF value |
| userId | ObjectId or null | owner sessions |
| envelopeId / recipientId | for signing sessions | scopes the session to exactly one recipient |
| ip, userAgent | string | |
| createdAt, expiresAt, revokedAt | Date | TTL index on expiresAt |

Indexes: `{ tokenHash: 1 }` unique, `{ expiresAt: 1 }` TTL, `{ userId: 1 }`.

### envelopes
| field | type | notes |
| --- | --- | --- |
| _id | ObjectId | |
| ownerId | ObjectId | |
| versionGroupId | ObjectId | stable across re issues, ties version history together |
| version | number | 1 based |
| supersedesId / supersededById | ObjectId or null | version chain |
| title, message | string | |
| status | enum | draft, sent, completed, approved, declined, voided, expired |
| signingOrder | 'parallel' or 'sequential' | |
| ownerIsSigner | boolean | |
| expiresAt | Date | |
| document | `{ key, sha256, size, pageCount, pages: [{ width, height, rotation }] }` | the uploaded original |
| sealed | `{ key, sha256, size, sealedAt }` or null | the final flattened artifact |
| recipients | Recipient[] | embedded, see below |
| fields | Field[] | embedded, see below |
| distribution | `{ approvedAt, approvedBy, deliveredAt, deliveredTo[] }` | |
| reminder | `{ intervalHours, nextAt, sentCount }` | |
| createdAt, updatedAt, sentAt, completedAt, voidedAt | Date | |

Indexes: `{ ownerId: 1, updatedAt: -1 }`, `{ 'recipients.tokenHash': 1 }`,
`{ versionGroupId: 1, version: -1 }`, `{ status: 1, expiresAt: 1 }`,
`{ status: 1, 'reminder.nextAt': 1 }`.

### Recipient (embedded)
`id` (uuid), `email`, `name`, `routingOrder` (int), `isOwner`, `status`
(pending, invited, viewed, verified, signed, declined), `tokenHash`, `tokenIssuedAt`,
`tokenExpiresAt`, `otp { hash, expiresAt, attempts, sentAt, resendCount }`,
`consent { agreedAt, text, adoptedName, signatureType }`, `signatureKey` (storage key of the
signature image), `invitedAt`, `viewedAt`, `signedAt`, `declinedAt`, `declineReason`,
`remindersSent`, `lastSeen { ip, userAgent }`.

### Field (embedded)
`id` (uuid), `recipientId`, `page` (1 based), `type`
(signature, initials, date, text, checkbox), `nx, ny, nw, nh` (normalized 0..1 rectangle in
**rendered page space**, origin top left), `required`, `label`, `fontSize`, `maxLength`,
`value`, `filledAt`. Signature and initials fields carry an image storage key in `value`.

### auditEvents
Append only hash chain. `{ _id, envelopeId, versionGroupId, seq, type, actorType, actorId,
actorEmail, at, ip, userAgent, meta, prevHash, hash }` where
`hash = sha256(prevHash + canonicalJson(event))`. Indexes: `{ envelopeId: 1, seq: 1 }` unique.

### emailLog
Delivery receipts and retry outcomes: `{ to, subject, template, envelopeId, provider,
providerMessageId, status, attempts, lastError, createdAt, sentAt }`.

### rateLimits
Fixed window counters with a TTL index: `{ _id: "scope:key:window", count, expiresAt }`.

## 2. Folder structure

```
signet/
  DOCS.md, PLAN.md, README.md, .env.example
  scripts/
    prototype-coordinates.mjs   coordinate mapping and flatten prototype
    verify-lifecycle.mjs        end to end lifecycle test against a live server
  src/
    app/
      (marketing)/page.tsx
      (auth)/login, (auth)/register
      dashboard/
      envelopes/new, envelopes/[id], envelopes/[id]/prepare
      sign/[token]/
      api/...
    components/ui/          design system primitives
    components/pdf/         renderer, field layer, palette
    components/sign/        signature pad, consent, field inputs
    lib/
      db/            mongo client, index bootstrap
      models/        typed documents and collection accessors
      auth/          password, session, csrf, guards
      pdf/           coordinates, fill, certificate, seal
      storage/       driver interface, encrypted local, S3 compatible, crypto
      email/         provider abstraction, retry, templates
      audit/         hash chain writer
      validation/    zod schemas
      util/          ids, http, errors, rate limit, request meta
  tests/
```

## 3. API endpoints

Auth
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`

Owner envelope lifecycle (owner session + CSRF required)
- `POST /api/envelopes` create draft from an uploaded PDF (multipart)
- `GET /api/envelopes` list, paginated and indexed
- `GET /api/envelopes/:id` detail
- `PATCH /api/envelopes/:id` draft metadata
- `PUT /api/envelopes/:id/recipients` replace recipient list (draft only)
- `PUT /api/envelopes/:id/fields` replace field layout (draft only)
- `POST /api/envelopes/:id/send` validate, mint tokens, dispatch invites
- `POST /api/envelopes/:id/remind` manual nudge to outstanding signers
- `POST /api/envelopes/:id/void` cancel a stalled envelope
- `POST /api/envelopes/:id/approve` approve distribution, seal, deliver
- `POST /api/envelopes/:id/new-version` re issue as version n+1
- `GET /api/envelopes/:id/document` stream the original
- `GET /api/envelopes/:id/preview` owner only in progress render
- `GET /api/envelopes/:id/sealed` stream the sealed final
- `GET /api/envelopes/:id/audit` audit trail

Recipient signing (token bound, OTP gated)
- `GET /api/sign/:token` resolve token to a minimal public state
- `POST /api/sign/:token/otp` send a passcode, `PUT /api/sign/:token/otp` verify it
- `GET /api/sign/:token/session` the recipient scoped view (own fields only)
- `GET /api/sign/:token/document` stream the PDF for display
- `PUT /api/sign/:token/fields` save own field values
- `POST /api/sign/:token/complete` adopt signature with explicit intent
- `POST /api/sign/:token/decline` decline with a reason
- `GET /api/sign/:token/sealed` download the sealed final after approval

System
- `POST /api/cron/maintenance` expiry sweep and reminder dispatch, bearer `CRON_SECRET`

## 4. Build order

1. Prototype PDF fill, flatten and coordinate mapping, prove a valid sealed PDF comes out.
2. Scaffold, design system, database and storage layers.
3. Owner registration, login/logout, dashboard, PDF draft upload, recipient editing and field
   placement.
4. Draft validation/send, invitations, OTP verification, scoped recipient document/field access,
   drawn signatures, consent, decline and manual reminders.
5. Completed: verified audit review, approval, sealed certificate, private download and public
   fingerprint verification. Remaining: distribution to signers.
6. Completed: expiry, automatic reminders, cancel (void). Remaining: versioning.
7. Lifecycle integration test in `src/test` (in progress: grows with each feature), then a trust
   and security review.


Trigger deploy
