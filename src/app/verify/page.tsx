import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { VerifyForm } from './verify-form';
import './verify.css';

export const metadata = {
  title: 'Verify a sealed document — Signet',
  description: 'Check the fingerprint and issuer signature of a Signet sealed PDF.',
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ sha256?: string }>;
}) {
  const params = await searchParams;
  const initialFingerprint = /^[a-fA-F0-9]{64}$/.test(params.sha256 ?? '')
    ? params.sha256!.toLowerCase()
    : '';
  return (
    <main className="verify-page">
      <header className="verify-header">
        <Link className="brand" href="/"><span className="verify-brand-mark">s</span><span>signet</span></Link>
        <Link href="/">Back to Signet</Link>
      </header>
      <section className="verify-panel">
        <span className="verify-icon"><ShieldCheck size={23} /></span>
        <p className="eyebrow">PUBLIC DOCUMENT CHECK</p>
        <h1>Verify a sealed agreement.</h1>
        <p className="verify-intro">
          Enter the sealed PDF fingerprint provided by the sender, or the evidence manifest
          digest printed on its certificate. Signet checks the manifest and issuer signature
          without revealing signer contact details.
        </p>
        <VerifyForm initialFingerprint={initialFingerprint} />
      </section>
      <footer className="verify-footer"><span>Independent checks for documents that matter.</span></footer>
    </main>
  );
}
