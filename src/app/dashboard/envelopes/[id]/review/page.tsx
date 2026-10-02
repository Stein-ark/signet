import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Check, FileText, ShieldCheck } from 'lucide-react';
import { readOwnerSession } from '@/lib/auth/session';
import { readChain, verifyChain } from '@/lib/audit/chain';
import { missingEvidence } from '@/lib/audit/evidence';
import { envelopes } from '@/lib/models/types';
import { ObjectId } from 'mongodb';
import { ApprovalActions } from './approval-actions';
import './review.css';

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}

export default async function EnvelopeReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const owner = await readOwnerSession();
  if (!owner) redirect('/login');
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();

  const envelope = await (await envelopes()).findOne({
    _id: new ObjectId(id),
    ownerId: owner.user._id,
  });
  if (!envelope) notFound();
  if (envelope.status !== 'completed' && envelope.status !== 'approved') redirect('/dashboard');

  const events = await readChain(envelope._id);
  const verification = verifyChain(events);
  const evidenceGap = missingEvidence(envelope, events);
  const allSigned = envelope.recipients.length > 0 &&
    envelope.recipients.every((recipient) => recipient.status === 'signed');
  const requiredFieldsComplete = envelope.fields.every(
    (field) => !field.required || (field.value !== null && field.value !== ''),
  );

  return (
    <main className="review-page">
      <header className="review-header">
        <Link className="brand" href="/dashboard">
          <Image src="/logo.png" alt="" width={34} height={28} priority />
          <span>signet</span>
        </Link>
        <Link href="/dashboard">Back to dashboard</Link>
      </header>
      <div className="review-content">
        <section className="review-title">
          <div>
            <p className="eyebrow">FINAL REVIEW</p>
            <h1>{envelope.title}</h1>
            <p>Review the signing record before approving the sealed document.</p>
          </div>
          <span className={`review-status review-${envelope.status}`}>
            {envelope.status === 'approved' ? 'Sealed' : 'Awaiting approval'}
          </span>
        </section>

        {!verification.valid && (
          <div className="review-integrity-error" role="alert">
            The audit trail does not verify at event {verification.brokenAt}. Do not approve this agreement.
          </div>
        )}
        {verification.valid && evidenceGap && envelope.status === 'completed' && (
          <div className="review-integrity-error" role="alert">
            {evidenceGap} Do not approve this agreement.
          </div>
        )}
        {verification.valid && (
          <div className="review-integrity-ok">
            <ShieldCheck size={17} /> Audit chain verified · {verification.eventCount} events
          </div>
        )}

        <div className="review-grid">
          <section className="review-card review-signers">
            <div className="review-card-title">
              <span><Check size={16} /></span>
              <div><h2>Signers</h2><p>Each signer verified their email and recorded consent.</p></div>
            </div>
            <div className="review-signer-list">
              {envelope.recipients.map((recipient) => (
                <article className="review-signer" key={recipient.id}>
                  <span className="signer-check"><Check size={15} /></span>
                  <div>
                    <h3>{recipient.consent?.adoptedName || recipient.name}</h3>
                    <p>{recipient.email}</p>
                  </div>
                  <div className="signer-time">
                    <strong>{recipient.signedAt ? formatDate(recipient.signedAt) : 'Not signed'}</strong>
                    <span>{recipient.consent?.signatureType === 'drawn' ? 'Drawn signature' : 'Signature missing'}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="review-card review-document">
            <div className="review-card-title">
              <span><FileText size={16} /></span>
              <div><h2>Original document</h2><p>{envelope.document.filename}</p></div>
            </div>
            <dl>
              <dt>Pages</dt><dd>{envelope.document.pageCount}</dd>
              <dt>File size</dt><dd>{(envelope.document.size / 1024).toFixed(0)} KB</dd>
              <dt>SHA-256</dt><dd className="review-hash">{envelope.document.sha256}</dd>
              <dt>Created</dt><dd>{formatDate(envelope.createdAt)}</dd>
              <dt>Sent</dt><dd>{envelope.sentAt ? formatDate(envelope.sentAt) : 'Not recorded'}</dd>
              <dt>Completed</dt><dd>{envelope.completedAt ? formatDate(envelope.completedAt) : 'Not recorded'}</dd>
            </dl>
            <a className="original-preview-link" href={`/api/envelopes/${id}/document`} target="_blank" rel="noreferrer">
              Preview original document
            </a>
          </section>

          <section className="review-card review-audit">
            <div className="review-card-title">
              <span><ShieldCheck size={16} /></span>
              <div><h2>Audit trail</h2><p>Append-only record included with the seal.</p></div>
            </div>
            <ol>
              {events.slice(-12).reverse().map((event) => (
                <li key={event._id.toHexString()}>
                  <span className="audit-dot" />
                  <div>
                    <strong>{event.type.replaceAll('.', ' ')}</strong>
                    <span>{event.actorName || event.actorEmail || event.actorType} · {formatDate(event.at)}</span>
                  </div>
                  <code>{event.hash.slice(0, 12)}</code>
                </li>
              ))}
            </ol>
            <Link href={`/api/envelopes/${id}/audit`} target="_blank">View full audit data</Link>
          </section>

          <section className="review-approval-card">
            <p className="eyebrow">APPROVAL</p>
            <h2>{envelope.status === 'approved' ? 'Your agreement is sealed.' : 'Ready to seal this agreement?'}</h2>
            <p>
              {envelope.status === 'approved'
                ? `Approved ${envelope.distribution.approvedAt ? formatDate(envelope.distribution.approvedAt) : ''}. The completed PDF includes the signature certificate and audit trail.`
                : 'Approval flattens the collected fields and appends a signed certificate. The resulting PDF is stored encrypted.'}
            </p>
            <ApprovalActions
              envelopeId={id}
              status={envelope.status}
              sealedSha256={envelope.sealed?.sha256 ?? null}
              canApprove={verification.valid && !evidenceGap && allSigned && requiredFieldsComplete}
            />
            {envelope.status === 'completed' && (
              <p className="approval-readiness">
                {allSigned ? 'All recipients have signed.' : 'Some recipients have not signed.'}
                {' '}
                {requiredFieldsComplete ? 'Required fields are complete.' : 'Some required fields are empty.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
