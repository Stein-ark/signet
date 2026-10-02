import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per request Content Security Policy.
 *
 * Next.js boots every page with inline scripts, so a static `script-src 'self'` policy blocks
 * hydration outright: pages render, but no click handler or form submit ever runs. Instead each
 * request gets a fresh random nonce. Next.js reads it from the request's CSP header and stamps
 * it on its own scripts, and 'strict-dynamic' lets those trusted scripts load the page bundles.
 * An injected inline script has no nonce and is still blocked, which is the protection that
 * matters for a product rendering untrusted PDFs and recipient supplied text.
 *
 * 'wasm-unsafe-eval' is required because pdf.js compiles a small WebAssembly module for image
 * decoding, and 'blob:' workers because the pdf.js worker is blob backed. React needs
 * 'unsafe-eval' in development only, for its debugging aids.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // Forbids framing so a hostile page cannot overlay a fake consent dialog on a real
    // signing session.
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    // Style attributes set by React and the PDF renderer need 'unsafe-inline'. Styles cannot
    // exfiltrate data here because no remote style origin is allowed.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    // Upgrading would break plain http on localhost, and production is always served over TLS.
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      // API responses are JSON or PDF streams and never execute script, and static assets do
      // not need a policy of their own.
      source: '/((?!api|_next/static|_next/image|favicon.ico|logo.png).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
