import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { AppError, badRequest, tooLarge } from '@/lib/util/errors';
import { env } from '@/lib/env';

/**
 * Request and response plumbing shared by every route handler.
 *
 * The goal is that a route handler contains business logic only: it throws AppError for
 * anything the caller did wrong and returns plain data for success. Everything about status
 * codes, error shapes, logging and header hygiene is decided in one place, here.
 */

export type RequestContext = {
  ip: string;
  userAgent: string;
  requestId: string;
};

/**
 * Best effort client IP.
 *
 * Behind a proxy the socket address is the proxy, so we read the standard forwarding headers.
 * These headers are attacker controllable when the app is exposed directly, which is why the
 * IP is recorded as evidence in the audit trail rather than used for any access decision.
 */
export function requestContext(request: Request): RequestContext {
  const headers = request.headers;
  const forwarded = headers.get('x-forwarded-for');
  const ip =
    (forwarded ? forwarded.split(',')[0]?.trim() : null) ||
    headers.get('x-real-ip') ||
    headers.get('cf-connecting-ip') ||
    'unknown';

  return {
    ip: ip.slice(0, 64),
    userAgent: (headers.get('user-agent') ?? 'unknown').slice(0, 512),
    requestId: randomUUID(),
  };
}

/** JSON success response with caching disabled. */
export function ok<T>(data: T, init?: { status?: number; headers?: HeadersInit }): NextResponse {
  const response = NextResponse.json(data, { status: init?.status ?? 200, headers: init?.headers });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Translate anything thrown inside a handler into a safe response body.
 *
 * Unknown errors are logged server side with a correlation id and reported to the client as a
 * generic failure carrying only that id.
 */
export function toErrorResponse(error: unknown, requestId: string): NextResponse {
  if (error instanceof AppError) {
    const body: Record<string, unknown> = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) {
      (body.error as Record<string, unknown>).details = error.details;
    }
    const response = NextResponse.json(body, { status: error.status });
    response.headers.set('Cache-Control', 'no-store');
    const retryAfter = (error.details as { retryAfterSeconds?: number } | undefined)
      ?.retryAfterSeconds;
    if (error.status === 429 && retryAfter) {
      response.headers.set('Retry-After', String(Math.ceil(retryAfter)));
    }
    return response;
  }

  if (error instanceof ZodError) {
    return toErrorResponse(badRequest('Some of those details are not valid.', fieldErrors(error)), requestId);
  }

  console.error(`[signet] unhandled error requestId=${requestId}`, error);
  const response = NextResponse.json(
    {
      error: {
        code: 'server_error',
        message: 'Something went wrong on our side. Nothing was changed.',
        requestId,
      },
    },
    { status: 500 },
  );
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** Flatten a Zod error into a per field message map suitable for showing in a form. */
export function fieldErrors(error: ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!result[key]) result[key] = issue.message;
  }
  return result;
}

/**
 * Wrap a route handler so that thrown errors become responses.
 *
 * Every handler in the app is wrapped with this. It is the reason no route needs its own
 * try/catch and the reason no internal error can escape as a stack trace.
 */
export function route<Args extends unknown[]>(
  handler: (request: Request, context: RequestContext, ...args: Args) => Promise<NextResponse>,
) {
  return async (request: Request, ...args: Args): Promise<NextResponse> => {
    const context = requestContext(request);
    try {
      return await handler(request, context, ...args);
    } catch (error) {
      return toErrorResponse(error, context.requestId);
    }
  };
}

/**
 * Read and validate a JSON body.
 *
 * The size guard exists because a route that parses an unbounded body is a trivial memory
 * exhaustion vector. Content type is checked so that a cross site form post (which can only
 * send a small set of content types) can never be parsed as an API call.
 */
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw badRequest('Expected a JSON request body.');
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  const limit = 2 * 1024 * 1024;
  if (declaredLength > limit) {
    throw tooLarge('That request body is too large.');
  }

  const text = await request.text();
  if (text.length > limit) {
    throw tooLarge('That request body is too large.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('That request body is not valid JSON.');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw badRequest('Some of those details are not valid.', fieldErrors(result.error));
  }
  return result.data;
}

/**
 * Verify that a state changing request came from our own origin.
 *
 * This is defence in depth alongside the SameSite cookie attribute and the double submit CSRF
 * token: even a browser that mishandles SameSite cannot forge a request that carries a
 * matching Origin header.
 */
export function assertSameOrigin(request: Request): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const origin = request.headers.get('origin');
  if (!origin) {
    // Some legitimate non browser clients omit Origin. The CSRF token check still applies, so
    // absence alone is not treated as an attack.
    return;
  }

  const expected = new URL(env().APP_URL).origin;
  if (origin !== expected) {
    throw new AppError(403, 'bad_origin', 'That request came from an unexpected origin.');
  }
}
