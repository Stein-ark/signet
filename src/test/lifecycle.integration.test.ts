import { ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { as, jar } from '@/test/cookie-jar';
import { makePng } from '@/test/png';

/*
 * End to end lifecycle through the real route handlers and a real (in memory) MongoDB replica
 * set. Only two things are simulated: the browser cookie jar behind next/headers, and the
 * mailbox, which is read from the console email driver's output.
 *
 * Each person gets their own browser (cookie jar). The owner's browser is also used when the
 * owner signs their own agreement, which is the situation that used to break owner CSRF.
 */

vi.mock('next/headers', async () => {
  const { jar } = await import('@/test/cookie-jar');
  return { cookies: async () => jar };
});

import * as registerRoute from '@/app/api/auth/register/route';
import * as loginRoute from '@/app/api/auth/login/route';
import * as envelopesRoute from '@/app/api/envelopes/route';
import * as envelopeRoute from '@/app/api/envelopes/[id]/route';
import * as recipientsRoute from '@/app/api/envelopes/[id]/recipients/route';
import * as fieldsRoute from '@/app/api/envelopes/[id]/fields/route';
import * as sendRoute from '@/app/api/envelopes/[id]/send/route';
import * as remindRoute from '@/app/api/envelopes/[id]/remind/route';
import * as voidRoute from '@/app/api/envelopes/[id]/void/route';
import * as approveRoute from '@/app/api/envelopes/[id]/approve/route';
import * as auditRoute from '@/app/api/envelopes/[id]/audit/route';
import * as signRoute from '@/app/api/sign/[token]/route';
import * as otpRoute from '@/app/api/sign/[token]/otp/route';
import * as sessionRoute from '@/app/api/sign/[token]/session/route';
import * as signFieldsRoute from '@/app/api/sign/[token]/fields/route';
import * as completeRoute from '@/app/api/sign/[token]/complete/route';
import * as declineRoute from '@/app/api/sign/[token]/decline/route';
import * as verifyRoute from '@/app/api/verify/[sha256]/route';
import * as maintenanceRoute from '@/app/api/cron/maintenance/route';
import { resetEnvCache } from '@/lib/env';
import { closeConnection } from '@/lib/db/mongo';
import { auditEvents, envelopes } from '@/lib/models/types';

const ORIGIN = 'http://signet.test';
const OWNER = { name: 'Olive Owner', email: 'olive@example.com', password: 'correct horse battery staple' };
const SIGNATURE = makePng().toString('base64');

let mongo: MongoMemoryReplSet;
let ownerCsrf = '';
let ipCounter = 10;

/* ------------------------------------------------------------------ *
 * Mailbox
 * ------------------------------------------------------------------ */

const mailbox: { to: string; subject: string; text: string }[] = [];
vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
  const match = /^\[signet email\] to=(\S+) subject=(.*)\n([\s\S]*)$/.exec(String(line));
  if (match) mailbox.push({ to: match[1]!, subject: match[2]!, text: match[3]! });
});

function lastEmail(to: string, subject?: RegExp) {
  const found = mailbox.filter((mail) => mail.to === to && (!subject || subject.test(mail.subject))).at(-1);
  if (!found) throw new Error(`No email to ${to}${subject ? ` matching ${subject}` : ''}`);
  return found;
}
const linkFrom = (text: string) => /\/sign\/([A-Za-z0-9_-]+)/.exec(text)![1]!;
const codeFrom = (text: string) => /is (\d{6})\./.exec(text)![1]!;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  handler: unknown,
  params: Record<string, string>,
  init: { method?: string; json?: unknown; csrf?: string; ip?: string; headers?: Record<string, string>; body?: BodyInit } = {},
) {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    'user-agent': 'vitest',
    'x-forwarded-for': init.ip ?? '198.51.100.1',
    ...(init.csrf ? { 'x-signet-csrf': init.csrf } : {}),
    ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
    ...init.headers,
  };
  const request = new Request(`${ORIGIN}/api`, {
    method: init.method ?? (init.json !== undefined || init.body ? 'POST' : 'GET'),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const response = await (handler as Handler)(request, { params: Promise.resolve(params) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/* ------------------------------------------------------------------ *
 * Scenario helpers
 * ------------------------------------------------------------------ */

async function uploadDraft(title: string): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  const form = new FormData();
  form.set('title', title);
  form.set('file', new File([Buffer.from(await pdf.save())], 'agreement.pdf', { type: 'application/pdf' }));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const result = await call(envelopesRoute.POST, {}, {
    method: 'POST',
    csrf: ownerCsrf,
    body,
    headers: { 'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.length) },
  });
  expect(result.status).toBe(201);
  return result.body.envelope.id;
}

type Signer = { email: string; name: string };

/** Create, prepare and send an agreement. Returns each signer's link and recipient id. */
async function sendAgreement(signers: Signer[], options: { sequential?: boolean; withExtras?: boolean } = {}) {
  const id = await uploadDraft('Services agreement');
  expect((await call(recipientsRoute.PUT, { id }, { method: 'PUT', csrf: ownerCsrf, json: { recipients: signers } })).status).toBe(200);
  const { body } = await call(envelopeRoute.GET, { id });
  const recipients = body.envelope.recipients as { id: string; email: string }[];

  const fields = recipients.flatMap((recipient, index) => [
    { id: crypto.randomUUID(), recipientId: recipient.id, page: 1, type: 'signature', nx: 0.1, ny: 0.1 + index * 0.2, nw: 0.3, nh: 0.06, required: true },
    ...(options.withExtras ? [
      { id: crypto.randomUUID(), recipientId: recipient.id, page: 1, type: 'text', nx: 0.5, ny: 0.1 + index * 0.2, nw: 0.3, nh: 0.04, required: true, label: 'Title' },
      { id: crypto.randomUUID(), recipientId: recipient.id, page: 1, type: 'date', nx: 0.5, ny: 0.15 + index * 0.2, nw: 0.2, nh: 0.04, required: false },
      { id: crypto.randomUUID(), recipientId: recipient.id, page: 1, type: 'checkbox', nx: 0.8, ny: 0.15 + index * 0.2, nw: 0.03, nh: 0.03, required: false },
    ] : []),
  ]);
  expect((await call(fieldsRoute.PUT, { id }, { method: 'PUT', csrf: ownerCsrf, json: { fields } })).status).toBe(200);

  if (options.sequential) {
    await (await envelopes()).updateOne({ _id: new ObjectId(id) }, { $set: { signingOrder: 'sequential' } });
  }
  const sent = await call(sendRoute.POST, { id }, { method: 'POST', csrf: ownerCsrf });
  expect(sent.status).toBe(200);

  const links = new Map<string, string>();
  for (const signer of signers) {
    const mail = mailbox.filter((item) => item.to === signer.email && /invited you/.test(item.subject)).at(-1);
    if (mail) links.set(signer.email, linkFrom(mail.text));
  }
  return { id, recipients, fields, links };
}

/** Prove control of the mailbox and open a signing session. Returns the signing CSRF token. */
async function verifySigner(token: string, email: string, browser = email): Promise<string> {
  return as(browser, async () => {
  expect((await call(signRoute.GET, { token })).status).toBe(200);
  expect((await call(otpRoute.POST, { token }, { method: 'POST' })).status).toBe(200);
  const code = codeFrom(lastEmail(email, /verification code/).text);
  expect((await call(otpRoute.PUT, { token }, { method: 'PUT', json: { code } })).status).toBe(200);
  const session = await call(sessionRoute.GET, { token });
  expect(session.status).toBe(200);
  return session.body.signing.csrfToken as string;
  });
}

async function sign(token: string, csrf: string, adoptedName: string) {
  return call(completeRoute.POST, { token }, {
    method: 'POST',
    csrf,
    json: { adoptedName, consent: true, signaturePng: SIGNATURE },
  });
}

async function eventsOf(id: string) {
  return (await auditEvents()).find({ envelopeId: new ObjectId(id) }).sort({ seq: 1 }).toArray();
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  resetEnvCache();

  const registered = await call(registerRoute.POST, {}, { method: 'POST', json: OWNER });
  expect(registered.status).toBe(201);
  ownerCsrf = jar.get('signet_csrf')!.value;
});

afterAll(async () => {
  await closeConnection();
  await mongo?.stop();
});

beforeEach(() => {
  mailbox.length = 0;
});

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

describe('signing lifecycle', () => {
  it('runs from upload to a publicly verifiable seal with two signers signing at once', async () => {
    const ada = { email: 'ada@example.com', name: 'Ada' };
    const owner = { email: OWNER.email, name: OWNER.name };
    const { id, recipients, fields, links } = await sendAgreement([ada, owner], { withExtras: true });
    expect(links.size).toBe(2);

    // Both signers open sessions before either finishes, as two people would in parallel.
    const adaCsrf = await verifySigner(links.get(ada.email)!, ada.email);
    const ownerSigningCsrf = await verifySigner(links.get(owner.email)!, owner.email, 'owner');

    // Signing in the owner's browser must not replace the owner's CSRF token.
    expect(jar.get('signet_csrf')?.value).toBe(ownerCsrf);

    const fieldFor = (email: string, type: string) => {
      const recipientId = recipients.find((item) => item.email === email)!.id;
      return fields.find((field) => field.recipientId === recipientId && field.type === type)!;
    };
    for (const [email, browser, csrf] of [[ada.email, ada.email, adaCsrf], [owner.email, 'owner', ownerSigningCsrf]] as const) {
      const token = links.get(email)!;
      const saved = await as(browser, () => call(signFieldsRoute.PUT, { token }, {
        method: 'PUT',
        csrf,
        json: { fields: [
          { id: fieldFor(email, 'text').id, value: 'Director' },
          { id: fieldFor(email, 'date').id, value: '2026-10-02' },
          { id: fieldFor(email, 'checkbox').id, value: 'true' },
        ] },
      }));
      expect(saved.status).toBe(200);
    }

    // Both sign at the same moment. A whole envelope version check made one of them fail with
    // "This signing request changed", and deciding completion from each request's own snapshot
    // could leave the envelope stuck with everyone signed.
    const results = await Promise.all([
      as(ada.email, () => sign(links.get(ada.email)!, adaCsrf, 'Ada Lovelace')),
      as('owner', () => sign(links.get(owner.email)!, ownerSigningCsrf, 'Olive Owner')),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results.filter((result) => result.body.envelopeCompleted)).toHaveLength(1);

    const stored = await (await envelopes()).findOne({ _id: new ObjectId(id) });
    expect(stored?.status).toBe('completed');
    expect(stored?.recipients.every((recipient) => recipient.status === 'signed' && recipient.viewedAt)).toBe(true);
    expect(stored?.fields.find((field) => field.id === fieldFor(ada.email, 'text').id)?.value).toBe('Director');
    expect((await eventsOf(id)).filter((event) => event.type === 'envelope.completed')).toHaveLength(1);

    // Owner actions still work with the original CSRF token after signing in the same browser.
    const approved = await call(approveRoute.POST, { id }, { method: 'POST', csrf: ownerCsrf });
    expect(approved.status).toBe(200);

    const verified = await call(verifyRoute.GET, { sha256: approved.body.sealed.sha256 });
    expect(verified.body).toMatchObject({
      verified: true,
      checks: { manifestDigest: true, issuerSignature: true, documentRecord: true },
      agreement: { signerCount: 2 },
    });

    const audit = await call(auditRoute.GET, { id });
    expect(audit.body.verification).toMatchObject({ valid: true, brokenAt: null });
  });

  it('rejects a wrong passcode and limits how often a link writes to the audit trail', async () => {
    const grace = { email: 'grace@example.com', name: 'Grace' };
    const { id, links } = await sendAgreement([grace]);
    const token = links.get(grace.email)!;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await call(signRoute.GET, { token })).status).toBe(200);
    }
    expect((await eventsOf(id)).filter((event) => event.type === 'recipient.link_opened')).toHaveLength(1);

    await call(otpRoute.POST, { token }, { method: 'POST' });
    const code = codeFrom(lastEmail(grace.email, /verification code/).text);
    const wrong = code === '000000' ? '111111' : '000000';
    const rejected = await call(otpRoute.PUT, { token }, { method: 'PUT', json: { code: wrong } });
    expect(rejected).toMatchObject({ status: 400, body: { error: { code: 'otp_invalid' } } });
    expect((await call(otpRoute.PUT, { token }, { method: 'PUT', json: { code } })).status).toBe(200);
  });

  it('rejects dates that are not on the calendar', async () => {
    const lin = { email: 'lin@example.com', name: 'Lin' };
    const { links, recipients, fields } = await sendAgreement([lin], { withExtras: true });
    const token = links.get(lin.email)!;
    const csrf = await verifySigner(token, lin.email);
    const date = fields.find((field) => field.recipientId === recipients[0]!.id && field.type === 'date')!;

    const result = await as(lin.email, () => call(signFieldsRoute.PUT, { token }, { method: 'PUT', csrf, json: { fields: [{ id: date.id, value: '2026-02-30' }] } }));
    expect(result).toMatchObject({ status: 409, body: { error: { message: 'A date field must be a valid date.' } } });
  });

  it('refuses a signature image that only looks like a PNG', async () => {
    const kai = { email: 'kai@example.com', name: 'Kai' };
    const { links } = await sendAgreement([kai]);
    const token = links.get(kai.email)!;
    const csrf = await verifySigner(token, kai.email);
    const corrupt = Buffer.concat([makePng().subarray(0, 33), Buffer.alloc(40)]).toString('base64');

    const result = await as(kai.email, () => call(completeRoute.POST, { token }, {
      method: 'POST',
      csrf,
      json: { adoptedName: 'Kai', consent: true, signaturePng: corrupt },
    }));
    expect(result.status).toBe(409);
  });

  it('closes the agreement for everyone when one signer declines', async () => {
    const a = { email: 'decliner@example.com', name: 'Dee' };
    const b = { email: 'bystander@example.com', name: 'Bo' };
    const { id, links } = await sendAgreement([a, b]);
    const csrf = await verifySigner(links.get(a.email)!, a.email);

    const declined = await as(a.email, () => call(declineRoute.POST, { token: links.get(a.email)! }, { method: 'POST', csrf, json: { reason: 'Wrong terms' } }));
    expect(declined.status).toBe(200);
    expect((await (await envelopes()).findOne({ _id: new ObjectId(id) }))?.status).toBe('declined');
    expect((await call(signRoute.GET, { token: links.get(b.email)! })).status).toBe(404);
  });
});

describe('cancelling an agreement', () => {
  it('stops the links and tells waiting recipients', async () => {
    const vic = { email: 'vic@example.com', name: 'Vic' };
    const { id, links } = await sendAgreement([vic]);

    expect((await call(voidRoute.POST, { id }, { method: 'POST', csrf: ownerCsrf, json: { reason: 'Superseded' } })).status).toBe(200);
    expect((await (await envelopes()).findOne({ _id: new ObjectId(id) }))?.status).toBe('voided');
    expect((await call(signRoute.GET, { token: links.get(vic.email)! })).status).toBe(404);
    expect(lastEmail(vic.email, /cancelled/).text).toContain('Superseded');
    expect((await eventsOf(id)).some((event) => event.type === 'envelope.voided')).toBe(true);

    // A cancelled agreement cannot be cancelled again.
    expect((await call(voidRoute.POST, { id }, { method: 'POST', csrf: ownerCsrf, json: { reason: 'Again' } })).status).toBe(409);
  });
});

describe('sequential routing', () => {
  it('invites each signer only when their turn arrives', async () => {
    const first = { email: 'first@example.com', name: 'First' };
    const second = { email: 'second@example.com', name: 'Second' };
    const { links } = await sendAgreement([first, second], { sequential: true });

    expect(links.has(first.email)).toBe(true);
    expect(links.has(second.email)).toBe(false);

    // A manual reminder now only goes to the signer who can act.
    mailbox.length = 0;
    const id = (await (await envelopes()).findOne({ 'recipients.email': second.email }, { sort: { _id: -1 } }))!._id.toHexString();
    expect((await call(remindRoute.POST, { id }, { method: 'POST', csrf: ownerCsrf })).body).toMatchObject({ reminded: 1 });
    expect(mailbox.map((mail) => mail.to)).toEqual([first.email]);
    const firstToken = linkFrom(lastEmail(first.email).text);

    const csrf = await verifySigner(firstToken, first.email);
    expect((await as(first.email, () => sign(firstToken, csrf, 'First Signer'))).body).toMatchObject({ envelopeCompleted: false });

    const secondToken = linkFrom(lastEmail(second.email, /invited you/).text);
    expect((await call(signRoute.GET, { token: secondToken })).status).toBe(200);
  });
});

describe('approval', () => {
  it('refuses to seal when the audit trail does not record the signatures', async () => {
    const sam = { email: 'sam@example.com', name: 'Sam' };
    const { id } = await sendAgreement([sam]);
    // Simulate a crash between the state change and its audit events.
    await (await envelopes()).updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status: 'completed',
          'recipients.0.status': 'signed',
          'recipients.0.signatureKey': 'envelopes/x/signature-1.png',
          'recipients.0.consent': { agreedAt: new Date(), text: 'x', adoptedName: 'Sam', signatureType: 'drawn' },
          'fields.0.value': 'envelopes/x/signature-1.png',
        },
      },
    );

    const result = await call(approveRoute.POST, { id }, { method: 'POST', csrf: ownerCsrf });
    expect(result.status).toBe(409);
    expect(result.body.error.message).toMatch(/does not record Sam/);
  });
});

describe('maintenance', () => {
  const cron = (secret?: string) =>
    call(maintenanceRoute.POST, {}, { method: 'POST', headers: secret ? { authorization: `Bearer ${secret}` } : {} });

  it('requires the cron secret', async () => {
    expect((await cron()).status).toBe(401);
    expect((await cron('not-the-secret')).status).toBe(401);
  });

  it('expires overdue agreements and sends due reminders without breaking earlier links', async () => {
    const late = { email: 'late@example.com', name: 'Late' };
    const slow = { email: 'slow@example.com', name: 'Slow' };
    const overdue = await sendAgreement([late]);
    const pending = await sendAgreement([slow]);
    const past = new Date(Date.now() - 60_000);
    await (await envelopes()).updateOne({ _id: new ObjectId(overdue.id) }, { $set: { expiresAt: past } });
    await (await envelopes()).updateOne({ _id: new ObjectId(pending.id) }, { $set: { 'reminder.nextAt': past } });
    mailbox.length = 0;

    const result = await cron(process.env.CRON_SECRET);
    expect(result.status).toBe(200);
    expect(result.body.expired).toBeGreaterThanOrEqual(1);
    expect(result.body.reminders.delivered).toBeGreaterThanOrEqual(1);

    expect((await (await envelopes()).findOne({ _id: new ObjectId(overdue.id) }))?.status).toBe('expired');
    expect((await eventsOf(overdue.id)).some((event) => event.type === 'envelope.expired')).toBe(true);

    const reminded = await (await envelopes()).findOne({ _id: new ObjectId(pending.id) });
    expect(reminded?.reminder.nextAt?.getTime()).toBeGreaterThan(Date.now());
    const newToken = linkFrom(lastEmail(slow.email).text);
    expect(newToken).not.toBe(pending.links.get(slow.email));
    expect((await call(signRoute.GET, { token: newToken })).status).toBe(200);
    expect((await call(signRoute.GET, { token: pending.links.get(slow.email)! })).status).toBe(200);

    // A second run straight away has nothing left to do.
    mailbox.length = 0;
    await cron(process.env.CRON_SECRET);
    expect(mailbox.filter((mail) => mail.to === slow.email)).toHaveLength(0);
  });
});

describe('sign in throttling', () => {
  it('slows a guesser down without locking the real owner out', async () => {
    const attackerIp = `203.0.113.${ipCounter++}`;
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      last = (await call(loginRoute.POST, {}, { method: 'POST', ip: attackerIp, json: { email: OWNER.email, password: 'wrong password' } })).status;
    }
    expect(last).toBe(429);

    const owner = await call(loginRoute.POST, {}, { method: 'POST', ip: `198.51.100.${ipCounter++}`, json: { email: OWNER.email, password: OWNER.password } });
    expect(owner.status).toBe(200);
    ownerCsrf = jar.get('signet_csrf')!.value;
  });
});
