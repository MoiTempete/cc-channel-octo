/**
 * `configure` subcommand backend: write the LLM gateway URL + API key into the
 * global config's `sdk` block. Daemon-driven one-click install calls
 * `cc-channel-octo configure --gateway-url <url> --api-key <key>`.
 *
 * Independent of loadConfig(): loadConfig requires apiUrl (bot binding comes
 * later via the provision flow), but install must be able to write gateway+key
 * before any bot exists. So this does a raw read-merge-write of the JSON file,
 * touching only sdk.anthropicBaseUrl + sdk.apiKey.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_CONFIG_PATH } from './config.js'
import { isAllowedApiUrl } from './url-policy.js'

/** Default Claude Code user settings file (the `env` block is what we import). */
export const DEFAULT_CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

/**
 * The Anthropic SDK appends `/v1/messages` to ANTHROPIC_BASE_URL. A gateway
 * pasted with a trailing `/v1` would otherwise yield `/v1/v1/messages` (404,
 * misreported as a model error). Strip a trailing `/v1` (optionally with a
 * slash) so the stored base is the host root. Pure for unit testing.
 */
export function normalizeGatewayUrl(raw: string): string {
  return raw.trim().replace(/\/v1\/?$/i, '')
}

export function configure(
  gatewayUrl: string,
  apiKey: string,
  configPath?: string,
  opts?: { model?: string; apiUrl?: string },
): void {
  if (!gatewayUrl) throw new Error('configure: --gateway-url is required')
  if (!apiKey) throw new Error('configure: --api-key is required')
  // The gateway receives the API key + all prompt/response content, so it gets
  // the same SSRF policy as apiUrl (mirrors loadConfig's anthropicBaseUrl check).
  if (!isAllowedApiUrl(gatewayUrl)) {
    throw new Error(`configure: unsafe --gateway-url ${gatewayUrl} (must be https:// or http://localhost)`)
  }
  // apiUrl is the Octo IM server (cc's top-level config.apiUrl). The daemon
  // passes its server url at install time so the zero-bot idle gateway can boot
  // (loadConfig requires apiUrl). Same SSRF policy as the gateway url.
  if (opts?.apiUrl && !isAllowedApiUrl(opts.apiUrl)) {
    throw new Error(`configure: unsafe --api-url ${opts.apiUrl} (must be https:// or http://localhost)`)
  }
  const normalizedUrl = normalizeGatewayUrl(gatewayUrl)
  const path = configPath ?? DEFAULT_CONFIG_PATH
  const existing = readExisting(path)
  // Narrow the existing sdk block to a plain object before merging (the file is
  // untyped JSON; repo lint forbids `any`, so read it as unknown + narrow).
  const existingSdk =
    existing.sdk && typeof existing.sdk === 'object' && !Array.isArray(existing.sdk)
      ? (existing.sdk as Record<string, unknown>)
      : {}
  const merged: Record<string, unknown> = {
    ...existing,
    sdk: { ...existingSdk, anthropicBaseUrl: normalizedUrl, apiKey },
  }
  // Write model only when provided; omitting it PRESERVES any existing sdk.model
  // (the existingSdk spread above) so a re-configure that just rotates the key
  // never wipes the model. Resetting model→default is intentionally not a
  // configure feature (add an explicit --clear-model later if ever needed).
  if (opts?.model) {
    (merged.sdk as Record<string, unknown>).model = opts.model
  }
  // The Octo IM server url lives at the top level (not under sdk).
  if (opts?.apiUrl) {
    merged.apiUrl = opts.apiUrl
  }
  writeAtomic(path, merged)
}

/** Read a config JSON as a plain record; throws a clear error on bad shape. */
function readExisting(path: string): Record<string, unknown> {
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      // Validate that the root is a plain object before treating it as one.
      if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
        throw new Error(`configure: existing config at ${path} is not a JSON object`)
      }
      existing = parsed as Record<string, unknown>
    } catch (err) {
      // Re-throw the clear "not a JSON object" error as-is; wrap parse errors.
      if (err instanceof Error && err.message.includes('is not a JSON object')) {
        throw err
      }
      throw new Error(`configure: failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return existing
}

/**
 * Atomic write: temp file in same directory with 0600 mode, then rename.
 * `wx` (exclusive create) refuses to write through a pre-existing file or a
 * symlink prepositioned at the temp path — important for a secret-bearing
 * writer. The pid+timestamp name makes a real collision practically impossible.
 */
function writeAtomic(path: string, merged: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(tmpPath, path)
    // Belt-and-suspenders: force 0600 on the final file too.
    chmodSync(path, 0o600)
  } catch (err) {
    // Best-effort cleanup of OUR temp file — but if the failure was EEXIST, the
    // path already existed and is not ours to delete.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        unlinkSync(tmpPath)
      } catch {
        /* already gone or never created — fine */
      }
    }
    throw new Error(`configure: failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Env vars from the Claude Code user settings env block that we import. */
const IMPORT_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];

/** Result of a --from-claude import: imported vars + ones we skipped. */
export interface FromClaudeResult {
  /** Imported `name → value` pairs (values may be secrets — print masked). */
  imported: Record<string, string>;
  /** Non-ANTHROPIC_/CLAUDE_CODE_ vars left untouched in the source file. */
  skipped: string[];
}

/**
 * Import the `env` block of Claude Code's user settings (~/.claude/settings.json)
 * into the target config's `sdk.env` — the one-command answer for third-party
 * LLM API users whose auth is a whole variable set (token + base URL + model
 * mapping), not a single key.
 *
 * Explicitly NOT an auto-inherit: only this command reads the personal file,
 * only the ANTHROPIC_* / CLAUDE_CODE_* subset is copied (a bot inheriting
 * arbitrary personal env would leak it to IM users), and the target file gets
 * the same 0o600 atomic write as configure().
 */
export function configureFromClaude(
  claudeSettingsPath: string,
  configPath: string,
): FromClaudeResult {
  if (!existsSync(claudeSettingsPath)) {
    throw new Error(
      `configure --from-claude: ${claudeSettingsPath} does not exist — ` +
      `run \`claude\` once and log in to create it, or pass a custom settings path`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8')) as unknown
  } catch (err) {
    throw new Error(
      `configure --from-claude: failed to parse ${claudeSettingsPath}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
    throw new Error(`configure --from-claude: ${claudeSettingsPath} is not a JSON object`)
  }
  const envRaw = (parsed as { env?: unknown }).env
  if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw)) {
    throw new Error(`configure --from-claude: no env block found in ${claudeSettingsPath}`)
  }
  const imported: Record<string, string> = {}
  const skipped: string[] = []
  for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
    if (IMPORT_ENV_PREFIXES.some((p) => key.startsWith(p)) && typeof value === 'string') {
      imported[key] = value
    } else {
      skipped.push(key)
    }
  }
  if (Object.keys(imported).length === 0) {
    throw new Error(
      `configure --from-claude: no ANTHROPIC_* / CLAUDE_CODE_* env vars in ${claudeSettingsPath}`,
    )
  }
  const existing = readExisting(configPath)
  const existingSdk =
    existing.sdk && typeof existing.sdk === 'object' && !Array.isArray(existing.sdk)
      ? (existing.sdk as Record<string, unknown>)
      : {}
  const existingEnv =
    existingSdk.env && typeof existingSdk.env === 'object' && !Array.isArray(existingSdk.env)
      ? (existingSdk.env as Record<string, unknown>)
      : {}
  // Merge: keep the operator's existing sdk.env keys, overwrite the imported ones.
  const merged: Record<string, unknown> = {
    ...existing,
    sdk: { ...existingSdk, env: { ...existingEnv, ...imported } },
  }
  writeAtomic(configPath, merged)
  return { imported, skipped }
}
