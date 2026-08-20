import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAuthSources, hasUsableAuthSource, maskKey, isAuthError } from '../auth-detect.js'

const NO_CREDS = '/nonexistent/.claude/.credentials.json'

let dir: string
let credsFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccauth-'))
  credsFile = join(dir, '.credentials.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('maskKey', () => {
  it('masks the middle of a long key, keeping first 5 + last 4', () => {
    expect(maskKey('sk-ihDN61JfoXyZa')).toBe('sk-ih****XyZa') // 16 chars
    expect(maskKey('sk-ihDN61JfoXyZ')).toBe('****') // 15 chars: 9 visible = 60% boundary
    expect(maskKey('sk-ihDN61JfoXy')).toBe('****') // 14 chars: 9 visible > 60%
  })
  it('fully masks short/empty values (would leak most of the value)', () => {
    expect(maskKey('')).toBe('****')
    expect(maskKey(undefined)).toBe('****')
    expect(maskKey('short')).toBe('****')
    expect(maskKey('sk-ihDN61Jfo')).toBe('****') // 12 chars
    expect(maskKey('sk-ihDN61Jf')).toBe('****')
    expect(maskKey('sk-13def1b10d7')).toBe('****') // 15 chars: boundary
  })
})

describe('detectAuthSources', () => {
  it('reports config.apiKey with a mask (highest precedence)', () => {
    const sources = detectAuthSources({ apiKey: 'sk-abcDEF12345678', env: { ANTHROPIC_API_KEY: 'sk-other' } }, {}, NO_CREDS)
    expect(sources.map((s) => s.kind)).toEqual(['config.apiKey'])
    expect(sources[0].masked).toBe('sk-ab****5678')
  })
  it('falls back to sdk.env.ANTHROPIC_API_KEY', () => {
    const sources = detectAuthSources({ env: { ANTHROPIC_API_KEY: 'sk-env-key' } }, {}, NO_CREDS)
    expect(sources.map((s) => s.kind)).toEqual(['config.env'])
  })
  it('accepts sdk.env.ANTHROPIC_AUTH_TOKEN (third-party gateway credential var)', () => {
    const sources = detectAuthSources({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-auth-token' } }, {}, NO_CREDS)
    expect(sources.map((s) => s.kind)).toEqual(['config.env'])
  })
  it('accepts CLAUDE_CODE_OAUTH_TOKEN (CLI CI-flow credential, importable via --from-claude)', () => {
    const sources = detectAuthSources({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-oauth-credential' } }, {}, NO_CREDS)
    expect(sources.map((s) => s.kind)).toEqual(['config.env'])
    const proc = detectAuthSources({}, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-oauth-credential' }, NO_CREDS)
    expect(proc.map((s) => s.kind)).toEqual(['process.env'])
  })
  it('accepts ANTHROPIC_AUTH_TOKEN from the process env too', () => {
    const sources = detectAuthSources({}, { ANTHROPIC_AUTH_TOKEN: 'sk-proc-token' }, NO_CREDS)
    expect(sources.map((s) => s.kind)).toEqual(['process.env'])
  })
  it('falls back to the process env (inherited into the SDK subprocess)', () => {
    const sources = detectAuthSources({}, { ANTHROPIC_API_KEY: 'sk-proc-key' }, NO_CREDS)
    expect(sources.map((s) => s.kind)).toEqual(['process.env'])
  })
  it('reports the OAuth file when nothing else exists', () => {
    writeFileSync(credsFile, '{"token":"sk-abc"}')
    const sources = detectAuthSources({}, {}, credsFile)
    expect(sources.map((s) => s.kind)).toEqual(['oauth-file'])
  })
  it('does NOT count an empty/corrupt OAuth file as authentication (P2-5)', () => {
    writeFileSync(credsFile, '{}')
    expect(detectAuthSources({}, {}, credsFile)).toEqual([])
    writeFileSync(credsFile, '{ broken')
    expect(detectAuthSources({}, {}, credsFile)).toEqual([])
  })
  it('returns [] when nothing is available (the Keychain-only case too)', () => {
    expect(detectAuthSources({}, {}, NO_CREDS)).toEqual([])
  })
  it('an empty-string config credential SHADOWS the process env (buildSdkEnv overlay, P2-1)', () => {
    // sdk.env spreads OVER baseEnv, so a declared-but-empty key makes the
    // subprocess unauthenticated; reporting process.env as the source would
    // be wrong (R5 P2-1).
    const sources = detectAuthSources(
      { env: { ANTHROPIC_API_KEY: '' } },
      { ANTHROPIC_API_KEY: 'sk-real-inherited' },
      NO_CREDS,
    )
    expect(sources.map((s) => s.kind)).toEqual(['config.env'])
    expect(sources[0].masked).toBe('****')
    // R6 B4: the empty source must be flagged as empty — verdicts count it
    // as missing instead of a false all-clear.
    expect(sources[0].empty).toBe(true)
    expect(hasUsableAuthSource(sources)).toBe(false)
  })
  it('a non-empty config credential is usable even when it shadows', () => {
    const sources = detectAuthSources(
      { env: { ANTHROPIC_AUTH_TOKEN: 'sk-gw-token' } },
      { ANTHROPIC_API_KEY: 'sk-real-inherited' },
      NO_CREDS,
    )
    expect(sources[0].empty).toBeUndefined()
    expect(hasUsableAuthSource(sources)).toBe(true)
  })
  it('ignores truly-absent keys', () => {
    expect(detectAuthSources({}, {}, NO_CREDS)).toEqual([])
  })
})

describe('isAuthError', () => {
  it('matches the SDK subprocess Not-logged-in error', () => {
    expect(isAuthError(new Error('Claude Code returned an error result: Not logged in · Please run /login'))).toBe(true)
  })
  it('matches explicit auth signatures (401 unauthorized / invalid key)', () => {
    expect(isAuthError(new Error('API request failed with status 401 Unauthorized'))).toBe(true)
    expect(isAuthError(new Error('authentication failed: invalid api key'))).toBe(true)
  })
  it('matches the Anthropic API structured error strings', () => {
    expect(isAuthError(new Error('invalid x-api-key'))).toBe(true)
    expect(isAuthError(new Error('authentication_error: invalid credentials'))).toBe(true)
    expect(isAuthError(new Error('status code 401: unauthorized'))).toBe(true)
  })
  it('matches the agent-bridge structured result error (api_error_status)', () => {
    expect(isAuthError(new Error('Claude Code returned an error result: error_during_execution (api_error_status=401)'))).toBe(true)
    expect(isAuthError(new Error('Claude Code returned an error result: error_connecting (api_error_status=403)'))).toBe(true)
    expect(isAuthError(new Error('Claude Code returned an error result: error_during_execution (api_error_status=429)'))).toBe(false)
  })
  it('does NOT match bare generic words (a tool call inside the agent may hit a 401)', () => {
    expect(isAuthError(new Error('tool api returned 401'))).toBe(false)
    expect(isAuthError(new Error('authentication service is down'))).toBe(false)
    expect(isAuthError(new Error('unauthorized access to file'))).toBe(false)
  })
  it('does not match unrelated errors', () => {
    expect(isAuthError(new Error('timeout after 60s'))).toBe(false)
    expect(isAuthError(new Error('No conversation found with session ID abc'))).toBe(false)
  })
})
