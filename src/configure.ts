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
import { displayBaseUrl } from './auth-detect.js'
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
  apiKey?: string,
  configPath?: string,
  opts?: { model?: string; apiUrl?: string },
): void {
  if (!gatewayUrl) throw new Error('configure: --gateway-url is required')
  // undefined = not provided (P2-10); an explicit EMPTY string clears a key.
  if (apiKey === undefined) throw new Error('configure: --api-key is required')
  // Trim surrounding whitespace (R6): a trailing newline in
  // CC_OCTO_CONFIGURE_API_KEY must not be persisted into the subprocess env.
  // Whitespace-only explicit input is a quoting mistake, not a CLEAR intent —
  // refuse it rather than silently wiping the configured credential (R7 P2).
  const trimmedKey = apiKey.trim()
  if (apiKey.length > 0 && trimmedKey.length === 0) {
    throw new Error('configure: --api-key is whitespace-only — did you mean to clear it? (use an empty string explicitly)')
  }
  apiKey = trimmedKey
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
  // 0700 on CREATED directories, not the ambient-umask default (R5 P2-9): the
  // 0600 file is useless if a co-located user can rename it away via a
  // group/other-writable directory. Tighten a PRE-EXISTING parent too (R6):
  // an install that already has ~/.cc-channel-octo at 0755 keeps its exposure
  // otherwise. Best-effort — a failure to tighten must not block the write.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirname(path), 0o700)
  } catch {
    // R7 P2: failing to tighten a group/other-writable parent undercuts the
    // threat model the 0600 file relies on — say so instead of silently
    // writing into an exposed directory.
    console.warn(
      `configure: could not tighten directory permissions on ${dirname(path)} — ` +
      `a group/other-writable parent lets co-located users rename config files away`,
    )
  }
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
  /** True when sdk.anthropicBaseUrl (configure --gateway-url) would shadow the imported ANTHROPIC_BASE_URL. */
  baseUrlConflict?: boolean;
  /** True when an existing sdk.apiKey (configure --api-key) shadows the imported ANTHROPIC_API_KEY / AUTH_TOKEN. */
  keyConflict?: boolean;
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
  globalConfigPath?: string,
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
  // Every imported value that LOOKS like an http(s) endpoint reaches the SDK
  // subprocess and receives the API key + all traffic, so each gets the SAME
  // SSRF policy as configure --gateway-url and loadConfig's anthropicBaseUrl
  // check. UNION of the two rules (R7 P1-2): value-based (catches FOO2_URL
  // and non-*_URL endpoint vars) OR name-based (ANTHROPIC_BASE_URL etc. even
  // with a leading-space prefix that the value test would miss — the WHATWG
  // URL parser trims leading C0 whitespace on the consumer side). Values are
  // TRIMMED before the check AND persisted trimmed, so a " https://…" prefix
  // can neither bypass the gate nor reach the subprocess. EMPTY values (a
  // common placeholder for "clear this override") skip the gate entirely —
  // they shadow nothing at runtime and must not abort the whole import.
  for (const [key, value] of Object.entries(imported)) {
    const v = value.trim()
    if (v.length > 0 && (/^https?:\/\//i.test(v) || /(?:^|_)[A-Za-z0-9]+_URL$/.test(key)) && !isAllowedApiUrl(v)) {
      throw new Error(
        `configure --from-claude: unsafe ${key}=${displayBaseUrl(v)} in ${claudeSettingsPath} ` +
        `(must be https:// or http://localhost) — fix it in your settings file and re-run`,
      )
    }
    imported[key] = v
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
  // P2-2: buildSdkEnv layers sdk.apiKey AFTER sdk.env, so a key written by an
  // earlier `configure --gateway-url --api-key` silently shadows an imported
  // token — warn symmetrically with baseUrlConflict. Same global-config check.
  // FIRST NON-EMPTY imported credential (Octo-Q P2): `??` picks the first
  // DEFINED value, so `{ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "tok"}`
  // would resolve to "" and miss the shadow — pick the first usable one.
  const importedKeyNonEmpty =
    (imported.ANTHROPIC_API_KEY && imported.ANTHROPIC_API_KEY.length > 0)
      ? imported.ANTHROPIC_API_KEY
      : (imported.ANTHROPIC_AUTH_TOKEN && imported.ANTHROPIC_AUTH_TOKEN.length > 0)
        ? imported.ANTHROPIC_AUTH_TOKEN
        : (imported.CLAUDE_CODE_OAUTH_TOKEN && imported.CLAUDE_CODE_OAUTH_TOKEN.length > 0)
          ? imported.CLAUDE_CODE_OAUTH_TOKEN
          : undefined
  const importedBaseUrlNonEmpty =
    imported.ANTHROPIC_BASE_URL && imported.ANTHROPIC_BASE_URL.length > 0
      ? imported.ANTHROPIC_BASE_URL
      : undefined
  let baseUrlConflict =
    // Non-empty only (R6): a cleared `--api-key ""` (or empty base URL) does
    // not shadow anything at runtime — buildSdkEnv skips falsy values.
    typeof existingSdk.anthropicBaseUrl === 'string' &&
      (existingSdk.anthropicBaseUrl as string).length > 0 &&
      importedBaseUrlNonEmpty !== undefined
  let keyConflict =
    typeof existingSdk.apiKey === 'string' && (existingSdk.apiKey as string).length > 0 && importedKeyNonEmpty !== undefined
  if (globalConfigPath !== undefined && globalConfigPath !== configPath) {
    try {
      const globalExisting = readExisting(globalConfigPath)
      const gsdk =
        globalExisting.sdk && typeof globalExisting.sdk === 'object' && !Array.isArray(globalExisting.sdk)
          ? (globalExisting.sdk as Record<string, unknown>)
          : {}
      // Gate on the SAME imported variables as the local checks (R7): a global
      // anthropicBaseUrl with no imported base URL shadows nothing.
      if (
        imported.ANTHROPIC_BASE_URL !== undefined &&
        typeof gsdk.anthropicBaseUrl === 'string' &&
        (gsdk.anthropicBaseUrl as string).length > 0
      ) baseUrlConflict = true
      if (importedKeyNonEmpty !== undefined && typeof gsdk.apiKey === 'string' && (gsdk.apiKey as string).length > 0) keyConflict = true
    } catch {
      // keep the per-file result when the global config is unreadable
    }
  }
  return { imported, skipped, baseUrlConflict, keyConflict }
}
