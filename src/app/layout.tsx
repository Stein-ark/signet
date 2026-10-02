import type { Metadata } from 'next';
import './globals.css';

// Every page is rendered per request so it can carry the CSP nonce set in `src/proxy.ts`. A page
// prerendered at build time has no nonce, and its scripts would be blocked.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Signet — signing you can trust',
  description:
    'Prepare, sign and seal important documents with clear consent and a complete audit trail.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
