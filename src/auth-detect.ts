/**
 * Claude authentication detection — pure, static.
 *
 * The gateway never knows (statically) whether the SDK subprocess will be able
 * to authenticate: credentials may come from the operator's config
 * (`sdk.apiKey` / `sdk.env`), from the gateway process environment (inherited
 * into the SDK subprocess via buildSdkEnv), or from the host's Claude Code
 * login state (`~/.claude/.credentials.json`, or the macOS Keychain, which
 * cannot be detected statically). Missing all of them is exactly the "Not
 * logged in · Please run /login" failure seen on the first message.
 *
 * These helpers are pure (config + env injected) so the detection matrix is
 * unit-testable, mirroring buildSdkEnv's injectable style.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The sdk subset these helpers read — mirrors buildSdkEnv's narrow input. */
export interface SdkAuthInput {
  apiKey?: string;
  env?: Record<string, string>;
}

/** Claude Code's OAuth credential file, checked as a static login signal. */
export const DEFAULT_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

export type AuthSourceKind =
  | 'config.apiKey' // operator configured sdk.apiKey (forwarded as ANTHROPIC_API_KEY)
  | 'config.env' // operator set sdk.env.ANTHROPIC_API_KEY
  | 'process.env' // gateway process env has ANTHROPIC_API_KEY (inherited)
  | 'oauth-file'; // host Claude Code OAuth login exists on disk

export interface AuthSourceInfo {
  kind: AuthSourceKind;
  /** Masked key for display (never the full secret). Absent for oauth-file. */
  masked?: string;
  /** Human-readable one-liner for diagnosis output. */
  describe: string;
}

/**
 * Mask a secret for logs/diagnosis: `sk-****Jfo` (first 5 + last 4 chars).
 * Credentials shorter than 13 chars (some gateway tokens are 11-12) would
 * reveal most of their value under that rule, so anything <= 12 is fully
 * masked.
 */
export function maskKey(key: string | undefined | null): string {
  if (!key) return '****';
  if (key.length <= 12) return '****';
  return `${key.slice(0, 5)}****${key.slice(-4)}`;
}

/**
 * Enumerate the Claude authentication sources available to one bot, in
 * precedence order (config wins over inherited env; static OAuth file last).
 * The `env` passed must be the gateway process env (what the SDK subprocess
 * would inherit via buildSdkEnv) — callers use process.env; tests inject it.
 *
 * Note: the macOS Keychain OAuth login has NO static file to probe, so a
 * user authenticated purely via Keychain shows up as `[]` here. Callers must
 * phrase the "no auth found" warning to acknowledge that case.
 */
/**
 * The two credential env vars the SDK subprocess (Claude Code CLI) accepts.
 * Third-party LLM gateways commonly use ANTHROPIC_AUTH_TOKEN (DeepSeek etc.),
 * so both must count as an authentication source.
 */
const KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** First non-empty value of the named env vars, or undefined. */
function firstEnvValue(env: Record<string, string | undefined> | undefined): string | undefined {
  if (!env) return undefined;
  for (const name of KEY_ENV_VARS) {
    const v = env[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function detectAuthSources(
  sdk: SdkAuthInput,
  baseEnv: NodeJS.ProcessEnv,
  credentialsPath: string = DEFAULT_CREDENTIALS_PATH,
): AuthSourceInfo[] {
  const sources: AuthSourceInfo[] = [];
  if (typeof sdk.apiKey === 'string' && sdk.apiKey.length > 0) {
    sources.push({
      kind: 'config.apiKey',
      masked: maskKey(sdk.apiKey),
      describe: 'sdk.apiKey in config (forwarded as ANTHROPIC_API_KEY)',
    });
  } else {
    const envKey = firstEnvValue(sdk.env);
    if (envKey !== undefined) {
      sources.push({
        kind: 'config.env',
        masked: maskKey(envKey),
        describe: 'sdk.env.ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config',
      });
    } else {
      const procKey = firstEnvValue(baseEnv as Record<string, string | undefined>);
      if (procKey !== undefined) {
        sources.push({
          kind: 'process.env',
          masked: maskKey(procKey),
          describe: 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in the gateway process environment',
        });
      }
    }
  }
  // OAuth login state is only a fallback signal: check it last and do not
  // let it shadow an explicitly configured key. A real login file is a
  // non-empty regular file — an empty file, a directory, or an unreadable
  // stub must not count as authentication.
  try {
    const st = statSync(credentialsPath);
    if (st.isFile() && st.size > 0) {
      sources.push({
        kind: 'oauth-file',
        describe: `host Claude Code login file ${credentialsPath}`,
      });
    }
  } catch {
    /* absent or unreadable — treat as no OAuth login */
  }
  return sources;
}

/**
 * Classify an agent-turn error (the Error thrown by the SDK stream, as
 * surfaced by stream-relay / queryAgent) as an authentication failure or not.
 * The literal "Not logged in" comes from the bundled Claude Code CLI in the
 * SDK subprocess; gateway-level errors surface as 401 / unauthorized from the
 * upstream API. This drives both the IM-side user-facing reply (owner gets
 * setup guidance) and operator logs.
 */
export function isAuthError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  // Anchor on the SDK subprocess's own signatures rather than bare words:
  // "authentication" or "401" alone appear in unrelated tool/service errors
  // (a skill's HTTP call, a MCP server), and misclassifying those would tell
  // the owner to re-run setup for nothing. Covers the Anthropic API's
  // structured error strings: "invalid x-api-key" (401 JSON body),
  // "authentication_error" (error type), "401 Unauthorized", "401: ...".
  return /not logged in|please run \/login|invalid api key|invalid x-api-key|authentication_error|authentication (failed|error|required)|api_error_status=(401|403|407)|401[:\s]+(unauthorized|invalid|error)|invalid (or expired )?credentials/i.test(m);
}
