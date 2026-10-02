import { notFound } from 'next/navigation';
import { AppError } from '@/lib/util/errors';
import { resolveSigningLink } from '@/lib/signing/resolve';
import { SigningWorkspace } from './signing-workspace';
import './signing.css';

export const dynamic = 'force-dynamic';

export default async function SigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let signing: Awaited<ReturnType<typeof resolveSigningLink>>;
  try {
    signing = await resolveSigningLink(token);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  return (
    <SigningWorkspace
      token={token}
      title={signing.envelope.title}
      ownerName={signing.envelope.ownerName}
      recipientName={signing.recipient.name}
    />
  );
}
