/**
 * The one billing provider that is live on this deployment, picked by BILLING_PROVIDER (creem | polar).
 * Routes and views call these helpers instead of a provider module directly.
 */
import type { Env } from '../env';
import * as creem from './creem';
import type { PlanId } from './plans';
import * as polar from './polar';

export function providerName(env: Env): 'Creem' | 'Polar' {
  return env.BILLING_PROVIDER === 'polar' ? 'Polar' : 'Creem';
}

export function billingEnabled(env: Env): boolean {
  return creem.creemEnabled(env) || polar.polarEnabled(env);
}

export function createCheckout(env: Env, user: { id: string; email: string; name: string }, plan: PlanId, interval: 'month' | 'year'): Promise<string> {
  return polar.polarEnabled(env) ? polar.createCheckout(env, user, plan, interval) : creem.createCheckout(env, user, plan, interval);
}

export function customerPortalUrl(env: Env, userId: string): Promise<string> {
  return polar.polarEnabled(env) ? polar.customerPortalUrl(env, userId) : creem.customerPortalUrl(env, userId);
}
