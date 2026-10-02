import type { NextConfig } from 'next';

/**
 * Security headers applied to every response.
 *
 * The Content Security Policy is not here: it carries a fresh nonce per request, so it is set
 * in `src/proxy.ts`.
 */
const securityHeaders = [
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
