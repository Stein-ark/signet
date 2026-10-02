import nodemailer from 'nodemailer';
import { env } from '@/lib/env';

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type EmailResult = {
  provider: string;
  providerMessageId: string | null;
};

export async function sendEmail(message: OutgoingEmail): Promise<EmailResult> {
  const config = env();

  if (config.EMAIL_DRIVER === 'console') {
    if (config.NODE_ENV === 'production') {
      throw new Error('Console email delivery is disabled in production.');
    }
    console.info(`[signet email] to=${message.to} subject=${message.subject}\n${message.text}`);
    return { provider: 'console', providerMessageId: null };
  }

  if (config.EMAIL_DRIVER === 'smtp') {
    const transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
    });
    const result = await transport.sendMail({
      from: config.EMAIL_FROM,
      to: message.to,
      replyTo: config.EMAIL_REPLY_TO,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { provider: 'smtp', providerMessageId: result.messageId || null };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [message.to],
      reply_to: config.EMAIL_REPLY_TO,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Resend delivery failed with ${response.status}: ${detail}`);
  }
  const result = (await response.json()) as { id?: string };
  return { provider: 'resend', providerMessageId: result.id ?? null };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}
