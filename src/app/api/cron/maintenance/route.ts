import { env } from '@/lib/env';
import {
  completeStalledEnvelopes,
  expireOverdueEnvelopes,
  sendDueReminders,
} from '@/lib/envelopes/lifecycle';
import { safeEqual } from '@/lib/util/crypto';
import { unauthorized } from '@/lib/util/errors';
import { ok, route, type RequestContext } from '@/lib/util/http';
import type { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Scheduled maintenance: expire overdue agreements, complete any whose final step was
 * interrupted, and send automatic reminders.
 *
 * Call it every few minutes with `Authorization: Bearer <CRON_SECRET>`. Every step is
 * idempotent and claims its work with a conditional update, so overlapping runs are harmless.
 * GET is accepted as well as POST because some schedulers can only issue GET requests.
 */
async function maintenance(request: Request, context: RequestContext): Promise<NextResponse> {
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!provided || !safeEqual(provided, env().CRON_SECRET)) throw unauthorized('Not authorized.');

  const system = { ip: 'system', userAgent: 'signet-maintenance' };
  const expired = await expireOverdueEnvelopes(system);
  const completed = await completeStalledEnvelopes(system);
  const reminders = await sendDueReminders(system);

  console.info(`[signet] maintenance requestId=${context.requestId} expired=${expired} completed=${completed} reminded=${reminders.delivered}`);
  return ok({ expired, completed, reminders });
}

export const GET = route(maintenance);
export const POST = route(maintenance);
