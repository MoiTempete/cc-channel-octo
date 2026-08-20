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

import { readFileSync, statSync } from 'node:fs';
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
  /**
   * True when the source is DECLARED but carries no usable value (e.g.
   * sdk.env.ANTHROPIC_API_KEY: ""). Such a source still SHADOWS inherited
   * credentials at runtime (buildSdkEnv spreads it over the process env), so
   * it must be surfaced — but it does NOT authenticate, and verdicts must
   * count it as missing (R6 B4: declared-but-empty produced a false OK).
   */
  empty?: boolean;
}

/**
 * Mask a secret for logs/diagnosis. Proportional visibility (R6): show at
 * most ~30% of the code points (capped at 9), so a 16-char token exposes 4
 * chars instead of 9 and a 13-char token exposes 3; anything that would show
 * fewer than 4 chars is fully masked. Measured in CODE POINTS (R5 P2-7):
 * `String.length` counts UTF-16 units, so an astral character would inflate
 * the length and let a short secret through; slice could split a pair.
 */
export function maskKey(key: string | undefined | null): string {
  if (!key) return '****';
  const units = [...key];
  const visible = Math.min(9, Math.floor(units.length * 0.3));
  if (visible < 4) return '****';
  const head = Math.ceil(visible / 2);
  const tail = Math.floor(visible / 2);
  return `${units.slice(0, head).join('')}****${units.slice(-tail).join('')}`;
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
 * The credential env vars the SDK subprocess (Claude Code CLI) accepts.
 * Third-party LLM gateways commonly use ANTHROPIC_AUTH_TOKEN (DeepSeek etc.);
 * CLAUDE_CODE_OAUTH_TOKEN is the CLI's documented CI-flow credential, which
 * --from-claude can import verbatim — counting it as a source keeps doctor's
 * verdict aligned with configs this PR itself can produce (Octo-Q P2-3).
 */
export const KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** First non-empty value of the named env vars, or undefined. */
function firstEnvValue(env: Record<string, string | undefined> | undefined): string | undefined {
  if (!env) return undefined;
  for (const name of KEY_ENV_VARS) {
    const v = env[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** True when `env` declares ANY credential key, even with an empty value. */
function envDeclaresCredential(env: Record<string, string | undefined> | undefined): boolean {
  if (!env) return false;
  return KEY_ENV_VARS.some((name) => Object.prototype.hasOwnProperty.call(env, name));
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
  } else if (envDeclaresCredential(sdk.env)) {
    // Model the buildSdkEnv overlay: sdk.env spreads OVER the process env, so
    // a key declared in config — even with an empty value — SHADOWS the
    // inherited one (R5 P2-1). But a declared-but-EMPTY value does not
    // authenticate: buildSdkEnv hands the subprocess the empty string and the
    // first message fails with "Not logged in". Surface it as an empty source
    // so verdicts count it as missing instead of a false OK (R6 B4).
    const envKey = firstEnvValue(sdk.env);
    sources.push({
      kind: 'config.env',
      masked: envKey !== undefined ? maskKey(envKey) : '****',
      ...(envKey === undefined ? { empty: true } : {}),
      describe:
        envKey !== undefined
          ? 'sdk.env.ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config'
          : 'sdk.env credential declared but EMPTY — shadows inherited credentials, does not authenticate',
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
  // OAuth login state is only a fallback signal: check it last and do not
  // let it shadow an explicitly configured key. A real login file is a
  // non-empty JSON object — `{}`, a corrupt file, or an empty stub must not
  // count as authentication (R5 P2-5).
  try {
    const st = statSync(credentialsPath);
    if (st.isFile() && st.size > 0) {
      const parsed: unknown = JSON.parse(readFileSync(credentialsPath, 'utf-8'));
      const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      if (isObject && Object.keys(parsed as Record<string, unknown>).length > 0) {
        sources.push({
          kind: 'oauth-file',
          describe: `host Claude Code login file ${credentialsPath}`,
        });
      }
    }
  } catch {
    /* absent, unreadable, or not a credentials JSON — treat as no OAuth login */
  }
  return sources;
}

/**
 * True when at least one source actually authenticates (a declared-but-empty
 * source shadows inherited credentials but carries no value — R6 B4).
 */
export function hasUsableAuthSource(sources: AuthSourceInfo[]): boolean {
  return sources.some((s) => !s.empty);
}

/**
 * Display a base URL without credentials: doctor prints ANTHROPIC_BASE_URL
 * while --from-claude masks the same variable — a URL with userinfo
 * (https://user:token@host) would leak its credential into scrollback. Strip
 * userinfo and path, keep scheme://host (masked when unparseable).
 */
export function displayBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return maskKey(url);
  }
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
  // R5 P2-6: the handleMessage catch also spans the Octo API (its errors are
  // "Octo API <path> failed (<status>): <body>") — a server-side 401 body
  // containing "authentication failed" must not be blamed on Claude.
  if (/^Octo API\b/.test(m)) return false;
  // Anchor on the SDK subprocess's own signatures rather than bare words:
  // "authentication" or "401" alone appear in unrelated tool/service errors
  // (a skill's HTTP call, a MCP server), and misclassifying those would tell
  // the owner to re-run setup for nothing. Covers the Anthropic API's
  // structured error strings: "invalid x-api-key" (401 JSON body),
  // "authentication_error" (error type), "401 Unauthorized", "401: ...".
  return /not logged in|please run \/login|invalid api key|invalid x-api-key|authentication_error|authentication (failed|error|required)|marker=(authentication_failed|oauth_org_not_allowed)|api_error_status=(401|403|407)|401[:\s]+(unauthorized|invalid|error)|invalid (or expired )?credentials/i.test(m);
}
