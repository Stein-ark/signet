import Image from 'next/image';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileText, Plus, Send, ShieldCheck } from 'lucide-react';
import { readOwnerSession } from '@/lib/auth/session';
import { envelopes, type EnvelopeDoc } from '@/lib/models/types';
import { SignOutButton } from './sign-out-button';
import { RemindButton } from './remind-button';
import { VoidButton } from './void-button';
import './dashboard.css';

const statusLabels: Record<EnvelopeDoc['status'], string> = {
  draft: 'Draft',
  sent: 'Awaiting signatures',
  completed: 'Ready for review',
  approved: 'Completed',
  declined: 'Declined',
  voided: 'Voided',
  expired: 'Expired',
};

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export default async function DashboardPage() {
  const owner = await readOwnerSession();
  if (!owner) redirect('/login');

  const rows = await (
    await envelopes()
  )
    .find(
      { ownerId: owner.user._id },
      {
        projection: {
          title: 1,
          status: 1,
          updatedAt: 1,
          'recipients.name': 1,
          'recipients.email': 1,
          'recipients.status': 1,
          'sealed.sha256': 1,
        },
      },
    )
    .sort({ updatedAt: -1 })
    .limit(20)
    .toArray();

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <Link className="brand" href="/">
          <Image src="/logo.png" alt="" width={34} height={28} priority />
          <span>signet</span>
        </Link>
        <div className="dashboard-account">
          <span>{owner.user.name}</span>
          <SignOutButton />
        </div>
      </header>

      <div className="dashboard-content">
        <section className="dashboard-welcome">
          <div>
            <p className="eyebrow">YOUR SIGNING DESK</p>
            <h1>Good to see you, {owner.user.name.split(/\s+/)[0]}.</h1>
            <p>Keep your agreements and signing activity together in one place.</p>
          </div>
          <span className="welcome-icon"><ShieldCheck size={25} strokeWidth={1.5} /></span>
        </section>

        <section className="dashboard-summary" aria-label="Signing overview">
          <article>
            <span className="summary-icon"><FileText size={18} /></span>
            <div><strong>{rows.length}</strong><span>Recent agreements</span></div>
          </article>
          <article>
            <span className="summary-icon"><Send size={18} /></span>
            <div>
              <strong>{rows.filter((row) => row.status === 'sent').length}</strong>
              <span>Awaiting signatures</span>
            </div>
          </article>
        </section>

        <section className="agreement-section">
          <div className="section-heading">
            <div>
              <h2>Your agreements</h2>
              <p>Your most recently updated documents.</p>
            </div>
            <Link className="coming-soon-action" href="/dashboard/new"><Plus size={16} /> New agreement</Link>
          </div>

          {rows.length ? (
            <div className="agreement-list">
              {rows.map((row) => (
                <article className="agreement-row" key={row._id.toHexString()}>
                  <span className="agreement-file-icon"><FileText size={19} /></span>
                  <div className="agreement-main">
                    <h3>
                      {row.status === 'draft' ? (
                        <Link href={`/dashboard/envelopes/${row._id.toHexString()}/prepare`}>{row.title}</Link>
                      ) : row.status === 'completed' || row.status === 'approved' ? (
                        <Link href={`/dashboard/envelopes/${row._id.toHexString()}/review`}>{row.title}</Link>
                      ) : row.title}
                    </h3>
                    <p>
                      {row.recipients.length
                        ? row.recipients.map((recipient) => recipient.name || recipient.email).join(', ')
                        : 'No recipients added'}
                    </p>
                  </div>
                  <span className={`agreement-status status-${row.status}`}>
                    {statusLabels[row.status]}
                  </span>
                  {row.status === 'sent' && (
                    <span className="agreement-actions">
                      <RemindButton envelopeId={row._id.toHexString()} />
                      <VoidButton envelopeId={row._id.toHexString()} />
                    </span>
                  )}
                  {row.status === 'approved' && (
                    <Link className="dashboard-download" href={`/api/envelopes/${row._id.toHexString()}/sealed`}>
                      Download
                    </Link>
                  )}
                  <time dateTime={row.updatedAt.toISOString()}>{formatDate(row.updatedAt)}</time>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon"><FileText size={24} /></span>
              <h3>Your signing desk is ready.</h3>
              <p>
                Your agreements will appear here. The document preparation flow is the next
                part of the Signet build.
              </p>
              <Link className="empty-create-link" href="/dashboard/new">
                <Plus size={15} /> Start an agreement
              </Link>
            </div>
          )}
        </section>
      </div>
      <footer className="dashboard-footer">
        <span>Careful signing for documents that matter.</span>
        <span>Signed in as {owner.user.email}</span>
      </footer>
    </main>
  );
}
