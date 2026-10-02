import { cookies } from 'next/headers';
import { ObjectId } from 'mongodb';
import { env, isSecureOrigin } from '@/lib/env';
import { sessions, users, type SessionDoc, type UserDoc } from '@/lib/models/types';
import { createSecretToken, hashSecret, newId, safeEqual } from '@/lib/util/crypto';
import { AppError, unauthorized } from '@/lib/util/errors';
import type { RequestContext } from '@/lib/util/http';

/**
 * Session management for both kinds of actor in the system.
 *
 * Signet has two completely separate identities, and keeping them separate is a security
 * requirement rather than a convenience:
 *
 *   Owners hold an account and a long lived session. They can create envelopes and read
 *   everything about their own.
 *
 *   Recipients hold no account at all. Their identity is the signing link, and a signing
 *   session only exists after they have proved control of the mailbox that link was sent to.
 *   A signing session is scoped to exactly one envelope and one recipient inside it, so it can
 *   never be used to read another recipient's fields or another envelope entirely.
 *
 * Session tokens are stored as keyed hashes. The raw value exists only in the cookie, so a
 * database compromise does not yield a set of usable sessions.
 */

const OWNER_COOKIE = 'signet_session';
const CSRF_COOKIE = 'signet_csrf';
const CSRF_HEADER = 'x-signet-csrf';

/** Signing cookies are namespaced per envelope so one browser can sign several documents. */
function signingCookieName(envelopeId: ObjectId | string): string {
  const id = typeof envelopeId === 'string' ? envelopeId : envelopeId.toHexString();
  return `signet_sign_${id}`;
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: isSecureOrigin(),
    // Lax rather than Strict so that following a signing link from an email client still
    // carries the session on the resulting top level navigation. All state changing requests
    // are POST or PUT and additionally carry a CSRF token, so Lax is not a weakening here.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/* ------------------------------------------------------------------ *
 * Owner sessions
 * ------------------------------------------------------------------ */

export async function createOwnerSession(user: UserDoc, context: RequestContext): Promise<void> {
  const { token, hash } = createSecretToken('owner-session');
  const csrfToken = newId();
  const maxAge = env().OWNER_SESSION_DAYS * 24 * 60 * 60;

  const collection = await sessions();
  await collection.insertOne({
    _id: new ObjectId(),
    kind: 'owner',
    tokenHash: hash,
    csrfToken,
    userId: user._id,
    envelopeId: null,
    recipientId: null,
    ip: context.ip,
    userAgent: context.userAgent,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + maxAge * 1000),
    revokedAt: null,
  });

  const jar = await cookies();
  jar.set(OWNER_COOKIE, token, cookieOptions(maxAge));
  // The CSRF cookie is deliberately readable by our own scripts: the browser echoes it back in
  // a header, and an attacker's origin cannot read it because of the same origin policy.
  jar.set(CSRF_COOKIE, csrfToken, { ...cookieOptions(maxAge), httpOnly: false });
}

export async function readOwnerSession(): Promise<{ session: SessionDoc; user: UserDoc } | null> {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;
  if (!token) return null;

  const collection = await sessions();
  const session = await collection.findOne({
    tokenHash: hashSecret(token, 'owner-session'),
    kind: 'owner',
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!session?.userId) return null;

  const user = await (await users()).findOne({ _id: session.userId });
  if (!user) return null;

  return { session, user };
}

/** Require an owner session, or fail the request. */
export async function requireOwner(): Promise<{ session: SessionDoc; user: UserDoc }> {
  const result = await readOwnerSession();
  if (!result) throw unauthorized();
  return result;
}

export async function destroyOwnerSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(OWNER_COOKIE)?.value;

  if (token) {
    const collection = await sessions();
    // Revoke rather than delete so that a suspicious sign out still leaves a trace of when the
    // session existed for anyone investigating an account later.
    await collection.updateOne(
      { tokenHash: hashSecret(token, 'owner-session') },
      { $set: { revokedAt: new Date() } },
    );
  }

  jar.delete(OWNER_COOKIE);
  jar.delete(CSRF_COOKIE);
}

/* ------------------------------------------------------------------ *
 * Signing sessions
 * ------------------------------------------------------------------ */

export async function createSigningSession(
  envelopeId: ObjectId,
  recipientId: string,
  context: RequestContext,
): Promise<void> {
  const { token, hash } = createSecretToken('signing-session');
  const csrfToken = newId();
  const maxAge = env().SIGNING_SESSION_MINUTES * 60;

  const collection = await sessions();

  // A fresh passcode verification replaces any earlier session for the same recipient, so a
  // signing session cannot quietly accumulate on a shared machine.
  await collection.updateMany(
    { kind: 'signing', envelopeId, recipientId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  await collection.insertOne({
    _id: new ObjectId(),
    kind: 'signing',
    tokenHash: hash,
    csrfToken,
    userId: null,
    envelopeId,
    recipientId,
    ip: context.ip,
    userAgent: context.userAgent,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + maxAge * 1000),
    revokedAt: null,
  });

  // No CSRF cookie here. The signing page receives its token in the session response body, and
  // the shared CSRF cookie belongs to the owner session: overwriting it would break every owner
  // action in a browser that has also signed a document.
  const jar = await cookies();
  jar.set(signingCookieName(envelopeId), token, cookieOptions(maxAge));
}

/**
 * Read the signing session for one envelope.
 *
 * The caller passes the envelope and recipient it resolved from the signing link, and this
 * function will only return a session that matches both. That check is what makes it
 * impossible to verify a passcode for one document and then reuse the resulting session
 * against another.
 */
export async function readSigningSession(
  envelopeId: ObjectId,
  recipientId: string,
): Promise<SessionDoc | null> {
  const jar = await cookies();
  const token = jar.get(signingCookieName(envelopeId))?.value;
  if (!token) return null;

  const collection = await sessions();
  const session = await collection.findOne({
    tokenHash: hashSecret(token, 'signing-session'),
    kind: 'signing',
    envelopeId,
    recipientId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });

  return session;
}

export async function destroySigningSession(
  envelopeId: ObjectId,
  recipientId: string,
): Promise<void> {
  const collection = await sessions();
  await collection.updateMany(
    { kind: 'signing', envelopeId, recipientId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  const jar = await cookies();
  jar.delete(signingCookieName(envelopeId));
}

/* ------------------------------------------------------------------ *
 * CSRF
 * ------------------------------------------------------------------ */

/**
 * Double submit CSRF check.
 *
 * The token lives in a cookie the browser sends automatically and in a header only our own
 * JavaScript can set. A cross site request can carry the cookie but cannot read it to set the
 * header, so the two only agree on a request that genuinely originated from our pages.
 */
export function assertCsrf(request: Request, session: SessionDoc): void {
  const provided = request.headers.get(CSRF_HEADER);
  if (!provided || !safeEqual(provided, session.csrfToken)) {
    throw new AppError(403, 'csrf_failed', 'That request could not be verified. Reload and try again.');
  }
}

export const CSRF_HEADER_NAME = CSRF_HEADER;
export const CSRF_COOKIE_NAME = CSRF_COOKIE;
