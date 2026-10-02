import type { Metadata } from 'next';
import './globals.css';

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
