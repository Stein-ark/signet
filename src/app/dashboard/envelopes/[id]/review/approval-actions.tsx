'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, Download, ShieldCheck } from 'lucide-react';

function csrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((cookie) => cookie.startsWith('signet_csrf='));
  return entry ? decodeURIComponent(entry.slice('signet_csrf='.length)) : '';
}

export function ApprovalActions({
  envelopeId,
  status,
  sealedSha256,
  canApprove,
}: {
  envelopeId: string;
  status: string;
  sealedSha256: string | null;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function approve() {
    setBusy(true);
    setError('');
    try {
      const token = csrfToken();
      if (!token) throw new Error('Your security token is missing. Reload the page and try again.');
      const response = await fetch(`/api/envelopes/${envelopeId}/approve`, {
        method: 'POST',
        headers: { 'x-signet-csrf': token },
      });
      const result = (await response.json()) as {
        envelope?: { status: string };
        error?: { message?: string };
      };
      if (!response.ok || result.envelope?.status !== 'approved') {
        throw new Error(result.error?.message ?? 'The agreement could not be sealed.');
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agreement could not be sealed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-actions">
      {status === 'completed' && (
        <>
          <p>Approving seals the completed PDF and its audit certificate. This cannot be undone.</p>
          {error && <p className="review-error" role="alert">{error}</p>}
          <button className="approve-button" type="button" onClick={approve} disabled={busy || !canApprove}>
            <ShieldCheck size={16} /> {busy ? 'Sealing document…' : 'Approve and seal'}
          </button>
          {!canApprove && <p className="review-error">Approval is disabled until the audit trail, signatures, and required fields are verified.</p>}
        </>
      )}
      {status === 'approved' && (
        <>
          <a className="download-sealed-button" href={`/api/envelopes/${envelopeId}/sealed`}>
            <Download size={15} /> Download sealed PDF
          </a>
          {sealedSha256 && (
            <a className="verify-sealed-link" href={`/verify?sha256=${sealedSha256}`}>
              Verify seal fingerprint
            </a>
          )}
          <span className="approved-indicator"><Check size={14} /> Sealed and approved</span>
        </>
      )}
    </div>
  );
}
