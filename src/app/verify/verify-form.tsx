'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';

type VerificationResult = {
  verified: boolean;
  checks?: { manifestDigest: boolean; issuerSignature: boolean; documentRecord: boolean };
  agreement?: {
    id: string;
    title: string;
    originalSha256: string | null;
    contentSha256: string | null;
    sealedSha256: string;
    sealedAt: string;
    pageCount: number | null;
    signerCount: number | null;
  };
  error?: { message?: string };
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function VerifyForm({ initialFingerprint = '' }: { initialFingerprint?: string }) {
  const [fingerprint, setFingerprint] = useState(initialFingerprint);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    setError('');
    setBusy(true);
    try {
      const normalized = fingerprint.trim().toLowerCase();
      const response = await fetch(`/api/verify/${encodeURIComponent(normalized)}`, { cache: 'no-store' });
      const body = (await response.json()) as VerificationResult;
      if (!response.ok) throw new Error(body.error?.message ?? 'No matching sealed document was found.');
      setResult(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Verification could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="verify-form" onSubmit={submit}>
        <label htmlFor="fingerprint">Sealed document fingerprint or certificate manifest digest</label>
        <input
          id="fingerprint"
          value={fingerprint}
          onChange={(event) => setFingerprint(event.target.value)}
          minLength={64}
          maxLength={64}
          pattern="[a-fA-F0-9]{64}"
          placeholder="64-character SHA-256 value"
          required
        />
        <button type="submit" disabled={busy || fingerprint.trim().length !== 64}>
          {busy ? 'Checking…' : 'Verify document'}
        </button>
      </form>
      {error && <p className="verify-error" role="alert">{error}</p>}
      {result && (
        <section className={`verify-result ${result.verified ? 'valid' : 'invalid'}`} aria-live="polite">
          <span>{result.verified ? <CheckCircle2 size={25} /> : <XCircle size={25} />}</span>
          <h2>{result.verified ? 'Seal verified.' : 'Verification failed.'}</h2>
          <p>
            {result.verified
              ? 'The certificate signature and manifest match Signet’s recorded seal.'
              : 'One or more integrity checks failed. Do not rely on this document as verified.'}
          </p>
          {result.agreement && (
            <dl>
              <dt>Agreement</dt><dd>{result.agreement.title}</dd>
              <dt>Sealed</dt><dd>{formatDate(result.agreement.sealedAt)}</dd>
              <dt>Pages</dt><dd>{result.agreement.pageCount ?? 'Not recorded'}</dd>
              <dt>Signers</dt><dd>{result.agreement.signerCount ?? 'Not recorded'}</dd>
              <dt>Document fingerprint</dt><dd className="verify-hash">{result.agreement.sealedSha256}</dd>
              {result.agreement.contentSha256 && (
                <><dt>Flattened pages fingerprint</dt><dd className="verify-hash">{result.agreement.contentSha256}</dd></>
              )}
            </dl>
          )}
          {result.checks && (
            <ul>
              <li>Manifest digest: {result.checks.manifestDigest ? 'valid' : 'invalid'}</li>
              <li>Issuer signature: {result.checks.issuerSignature ? 'valid' : 'invalid'}</li>
              <li>Stored document record: {result.checks.documentRecord ? 'valid' : 'invalid'}</li>
            </ul>
          )}
        </section>
      )}
    </>
  );
}
