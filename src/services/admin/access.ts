/**
 * The caller's own admin access, for any signed-in principal. It answers "why can't my agent see
 * admin tools, and how do I fix it?" without revealing anything about other users or the system:
 * only the caller's role, effective scopes, the admin scopes that role could hold, tool names and
 * how to reconnect. Roles without admin access learn only that they have none.
 */
import { ADMIN_SCOPES, KEY_PRESETS, OAUTH_ADMIN_PRESET_IDS, oauthAdminPresetScopes, scopesForRole } from '../../auth/roles';
import type { Env, Principal, Scope } from '../../env';
import { now } from '../../lib/util';
import { AdminError, iso } from './shared';

/** A tool as the access report sees it: its name and the scope it needs (null: any signed-in caller). */
export interface CatalogEntry {
  name: string;
  scope: Scope | null;
}

export type AccessState = 'not_eligible' | 'not_granted' | 'partial' | 'full';

/** The read-only admin scopes, in role-template order: what a monitoring agent needs. */
const ADMIN_READ_SCOPES: Scope[] = ['settings:read', 'optouts:read', 'users:read', 'credits:read', 'billing:read', 'audit:read', 'system:read'];

const sortScopes = (scopes: Iterable<Scope>) => [...new Set(scopes)].sort();

export function adminAccessStatus(env: Pick<Env, 'PUBLIC_URL'>, actor: Principal, catalog: readonly CatalogEntry[]) {
  if (!actor.userId) throw new AdminError('Sign in or send an API key.', 401, 'unauthorized');
  const held = new Set(actor.scopes);
  const roleAdmin = scopesForRole(actor.role).filter((s) => ADMIN_SCOPES.has(s));
  const heldAdmin = roleAdmin.filter((s) => held.has(s));
  const missingAdmin = roleAdmin.filter((s) => !held.has(s));
  const state: AccessState = !roleAdmin.length ? 'not_eligible' : !heldAdmin.length ? 'not_granted' : missingAdmin.length ? 'partial' : 'full';
  const base = {
    generated_at: iso(now()),
    caller: {
      user_id: actor.userId,
      role: actor.role,
      auth_kind: actor.kind,
      ...(actor.apiKeyId ? { api_key_id: actor.apiKeyId } : {}),
      ...(actor.clientId ? { oauth_client_id: actor.clientId } : {}),
    },
    effective_scopes: sortScopes(actor.scopes),
    state,
  };
  if (state === 'not_eligible') {
    return {
      ...base,
      diagnosis: `Your role (${actor.role}) has no admin access. Only an owner can change roles; nothing a client or key requests can add it.`,
      admin: null,
    };
  }

  const adminTools = catalog.filter((t) => t.scope && ADMIN_SCOPES.has(t.scope) && roleAdmin.includes(t.scope));
  const available = adminTools.filter((t) => t.scope && held.has(t.scope)).map((t) => t.name);
  const eligible = adminTools.filter((t) => t.scope && !held.has(t.scope)).map((t) => ({ name: t.name, scope: t.scope }));
  // What a monitoring agent should hold: what it has now plus the read-only admin scopes the role allows.
  const readMissing = ADMIN_READ_SCOPES.filter((s) => roleAdmin.includes(s) && !held.has(s));
  const stepUpScope = sortScopes([...actor.scopes, ...readMissing]).join(' ');
  const mcpUrl = `${env.PUBLIC_URL}/mcp`;

  const presets =
    actor.kind === 'oauth'
      ? OAUTH_ADMIN_PRESET_IDS.map((id) => ({ id, adds: oauthAdminPresetScopes(actor.role, id).filter((s) => !held.has(s)) }))
      : KEY_PRESETS.filter((p) => p.id === 'admin-read-only' || p.id === 'support' || p.id === 'site-ops').map((p) => ({
          id: p.id,
          scopes: p.scopes.filter((s) => roleAdmin.includes(s) || !ADMIN_SCOPES.has(s)),
        }));

  return {
    ...base,
    diagnosis: diagnosis(actor, state),
    admin: {
      role_allows: sortScopes(roleAdmin),
      granted: sortScopes(heldAdmin),
      missing: sortScopes(missingAdmin),
      tools_available: available,
      tools_after_reauthorization: eligible,
      presets,
      how_to_fix: state === 'full' ? null : howToFix(actor, stepUpScope, mcpUrl),
      docs: `${env.PUBLIC_URL}/docs/mcp#set-up-an-admin-agent`,
    },
  };
}

function diagnosis(actor: Principal, state: AccessState): string {
  if (state === 'full') return 'This credential holds every admin scope your role allows. Start with system_overview or get_user_stats.';
  const some = state === 'partial' ? 'holds some admin scopes but not all your role allows' : 'holds no admin scopes';
  if (actor.kind === 'oauth') return `Your role (${actor.role}) allows admin access, but this OAuth connection ${some}. Connections get the basic set unless you choose admin access on the consent screen.`;
  if (actor.kind === 'api_key') return `Your role (${actor.role}) allows admin access, but this API key ${some}. A key keeps the scopes it was created with.`;
  return `Your role (${actor.role}) allows admin access, but this session ${some}.`;
}

function howToFix(actor: Principal, stepUpScope: string, mcpUrl: string) {
  if (actor.kind === 'oauth') {
    return {
      steps: [
        'Disconnect anymd in your MCP client and connect it again.',
        'On the anymd consent screen, choose an admin access option (Admin read-only for reports, Support for account help) and approve.',
        'Call get_admin_access_status again: the admin tools are listed once the new connection holds their scopes.',
      ],
      step_up: {
        description: 'Clients that support OAuth step-up can instead call an admin tool (for example system_overview) directly: anymd answers HTTP 403 with WWW-Authenticate error="insufficient_scope" and the scope set below, and the client re-authorizes.',
        scope: stepUpScope,
      },
    };
  }
  if (actor.kind === 'api_key') {
    return {
      steps: [
        'Create an API key with the admin-read-only preset (or support / site-ops) in Dashboard → API keys.',
        `Reconnect your MCP client with it: claude mcp add --transport http anymd-admin ${mcpUrl} --header "Authorization: Bearer amd_…"`,
        'Revoke the old key if it is no longer needed.',
      ],
    };
  }
  return { steps: ['Sign out and in again; browser sessions hold every scope of your role.'] };
}
