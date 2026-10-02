import { ObjectId } from 'mongodb';
import { redirect, notFound } from 'next/navigation';
import { readOwnerSession } from '@/lib/auth/session';
import { envelopes } from '@/lib/models/types';
import { PrepareWorkspace } from './prepare-workspace';
import './prepare.css';

export default async function PrepareEnvelopePage({
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
  if (envelope.status !== 'draft') redirect('/dashboard');

  return (
    <PrepareWorkspace
      initial={{
        id: envelope._id.toHexString(),
        title: envelope.title,
        status: envelope.status,
        recipients: envelope.recipients.map(({ id: recipientId, name, email, routingOrder }) => ({
          id: recipientId,
          name,
          email,
          routingOrder,
        })),
        fields: envelope.fields.map(({ id: fieldId, recipientId, page, type, nx, ny, nw, nh, required, label, fontSize, maxLength }) => ({
          id: fieldId,
          recipientId,
          page,
          type,
          nx,
          ny,
          nw,
          nh,
          required,
          label,
          fontSize,
          maxLength,
        })),
        document: {
          filename: envelope.document.filename,
          pageCount: envelope.document.pageCount,
        },
      }}
    />
  );
}
