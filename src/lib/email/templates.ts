import { env } from '@/lib/env';
import { escapeHtml, type OutgoingEmail } from '@/lib/email/send';

export function invitationEmail(input: {
  to: string;
  ownerName: string;
  title: string;
  token: string;
}): OutgoingEmail {
  const url = `${env().APP_URL.replace(/\/$/, '')}/sign/${encodeURIComponent(input.token)}`;
  const owner = escapeHtml(input.ownerName);
  const title = escapeHtml(input.title);
  return {
    to: input.to,
    subject: `${input.ownerName} invited you to sign ${input.title}`,
    text: `${input.ownerName} has asked you to review and sign "${input.title}".\n\nOpen your secure signing link: ${url}\n\nYou will verify access using a one-time code sent to this email address.`,
    html: `<p>${owner} has asked you to review and sign <strong>${title}</strong>.</p><p><a href="${url}">Review and sign the document</a></p><p>You will verify access using a one-time code sent to this email address.</p>`,
  };
}

export function otpEmail(input: { to: string; title: string; code: string }): OutgoingEmail {
  const title = escapeHtml(input.title);
  return {
    to: input.to,
    subject: `Your Signet verification code for ${input.title}`,
    text: `Your verification code for "${input.title}" is ${input.code}. It expires in ${env().OTP_TTL_MINUTES} minutes. If you did not request it, you can ignore this email.`,
    html: `<p>Your verification code for <strong>${title}</strong> is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${input.code}</p><p>It expires in ${env().OTP_TTL_MINUTES} minutes. If you did not request it, you can ignore this email.</p>`,
  };
}
