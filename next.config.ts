import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * The content security policy is deliberately tight. Signet renders untrusted PDFs and
 * untrusted recipient supplied text, so script injection is the highest value attack. We do
 * not allow inline script, we do not allow any remote origin to load script or styles, and we
 * forbid the app from being framed so that a hostile page cannot overlay a fake consent
 * dialog on top of a real signing session (clickjacking a signature would defeat the intent
 * pillar entirely).
 *
 * 'wasm-unsafe-eval' is required because pdf.js compiles a small WebAssembly module for image
 * decoding. 'blob:' worker and child sources are required because the pdf.js worker and the
 * object URLs used to stream a PDF into the renderer are blob backed.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // Next injects a nonce free inline style for its font and streaming runtime, so styles need
  // 'unsafe-inline'. Styles cannot exfiltrate data here because no remote style origin is
  // allowed and there are no CSS variables carrying secrets.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob:",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=()',
  },
  {
    // Only meaningful when served over TLS, which production always is.
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Documents are streamed from encrypted storage through route handlers, never from the
  // Next image or static pipeline, so no remote patterns are needed.
  images: { remotePatterns: [] },

  serverExternalPackages: ['mongodb'],

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Signing links and document streams must never be cached by a shared proxy.
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' }],
      },
    ];
  },
};

export default nextConfig;
