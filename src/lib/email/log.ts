import { ObjectId } from 'mongodb';
import { emailLog, type EmailLogDoc } from '@/lib/models/types';
import type { EmailResult, OutgoingEmail } from '@/lib/email/send';

export async function logEmail(input: {
  message: OutgoingEmail;
  envelopeId: ObjectId | null;
  template: string;
  result?: EmailResult;
  error?: unknown;
}): Promise<void> {
  const now = new Date();
  const row: EmailLogDoc = {
    _id: new ObjectId(),
    to: input.message.to,
    subject: input.message.subject,
    template: input.template,
    envelopeId: input.envelopeId,
    provider: input.result?.provider ?? 'unknown',
    providerMessageId: input.result?.providerMessageId ?? null,
    status: input.error ? 'failed' : 'sent',
    attempts: 1,
    lastError:
      input.error instanceof Error ? input.error.message.slice(0, 500) : input.error ? 'Unknown delivery error.' : null,
    createdAt: now,
    sentAt: input.error ? null : now,
  };
  await (await emailLog()).insertOne(row);
}
