import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorReport, listBotIds, runDoctor, displayBaseUrl } from '../doctor.js'

let dir: string
let cfgPath: string
const NO_CREDS = '/nonexistent/.claude/.credentials.json'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccdoc-'))
  cfgPath = join(dir, 'config.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeGlobal(bots: unknown, extra: Record<string, unknown> = {}): void {
  writeFileSync(cfgPath, JSON.stringify({ apiUrl: 'https://octo.example.com', bots, ...extra }), { mode: 0o600 })
}
function writeBot(id: string, cfg: Record<string, unknown>): void {
  const botDir = join(dir, id)
  mkdirSync(botDir, { recursive: true })
  writeFileSync(join(botDir, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
}

describe('doctorReport', () => {
  it('reports NOT INITIALIZED when the global config is missing', () => {
    const report = doctorReport(join(dir, 'missing.json'), {}, NO_CREDS)
    expect(report.text).toContain('NOT FOUND')
    expect(report.text).toContain('verdict: NOT INITIALIZED')
    expect(report.missing).toBe(0)
    expect(report.hasBots).toBe(false)
  })

  it('verdict OK when a bot has sdk.apiKey; masks the key in the report', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-topSecretValue' } })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.missing).toBe(0)
    expect(report.text).toContain('verdict: OK')
    expect(report.text).toContain('sk-to****alue') // masked, never the full key
    expect(report.text).not.toContain('sk-topSecretValue')
  })

  it('flags UNKNOWN when a bot has no source at all, and counts it as missing', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.missing).toBe(1)
    expect(report.text).toContain('verdict: UNKNOWN (no usable auth source)')
    expect(report.text).toContain('npm run setup') // the first suggested fix
    expect(report.text).toContain('claude auth status') // Keychain hedge
  })

  it('accepts an inherited ANTHROPIC_API_KEY from the process env', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, { ANTHROPIC_API_KEY: 'sk-inheritedKey' }, NO_CREDS)
    expect(report.missing).toBe(0)
    expect(report.text).toContain('process.env')
  })

  it('counts a GLOBAL sdk.apiKey for bots that do not override it (runtime merge semantics)', () => {
    // configure writes to the global config by default — a bot with only a
    // botToken still authenticates via the inherited global sdk block.
    writeGlobal([{ id: 'default' }], { sdk: { apiKey: 'sk-globalSecretKey' } })
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.missing).toBe(0)
    expect(report.text).toContain('(from global config)')
    expect(report.text).toContain('sk-gl****tKey') // masked
    expect(report.text).not.toContain('sk-globalSecretKey')
  })

  it('does NOT lose a global apiKey when the per-bot sdk block carries only model (P1-2)', () => {
    // The runtime merge (config.ts) never materialises explicit undefined keys;
    // doctor must match it, or a common `sdk: { model }` override would make a
    // healthy install report MISSING.
    writeGlobal([{ id: 'default' }], { sdk: { apiKey: 'sk-globalKey12345' } })
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { model: 'deepseek-v4' } })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.missing).toBe(0)
    expect(report.text).toContain('(from global config)')
  })

  it('reports a global sdk summary line incl. ANTHROPIC_AUTH_TOKEN', () => {
    writeGlobal([{ id: 'default' }], { sdk: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-globalAuthToken' } } })
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('sdk: credential sk-gl****oken (base inherited by all bots)')
  })

  it('multi-bot: counts missing per bot and does not let a healthy sibling mask a broken one (P1-3)', () => {
    writeGlobal([{ id: 'good' }, { id: 'bad' }])
    writeBot('good', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-goodKey12345' } })
    writeBot('bad', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.missing).toBe(1)
    expect(report.text).toContain('bot "good"')
    expect(report.text).toContain('bot "bad"')
    expect(report.text).toContain('verdict: 1 bot(s) without a statically detectable auth source')
  })

  it('does not label process.env / oauth-file sources as "(from global config)"', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, { ANTHROPIC_API_KEY: 'sk-inheritedKey' }, NO_CREDS)
    expect(report.text).toContain('process.env')
    expect(report.text).not.toContain('(from global config)')
  })

  it('warns when a config file is group/other readable', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-x' } })
    chmodSync(cfgPath, 0o644)
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('group/other readable')
  })

  it('reports an absent per-bot config with no token anywhere as missing', () => {
    writeGlobal([{ id: 'default' }])
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('MISSING BOT TOKEN')
    expect(report.missing).toBe(1)
  })

  it('discovers the LEGACY top-level botToken shape (no bots[], no per-bot file)', () => {
    // resolveBotConfigs synthesizes { id: 'default', botToken } from a global
    // top-level botToken — doctor must diagnose that bot, not report idle.
    writeGlobal(undefined, { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.hasBots).toBe(true)
    expect(report.text).toContain('bot "default"')
    expect(report.text).not.toContain('none configured')
    expect(report.missing).toBe(1) // no auth source → NOT a false-success exit 0
  })

  it('accepts an inline bots[].botToken with no per-bot file (runtime needs no file)', () => {
    // Healthy: inline token + global sdk.apiKey. Previously doctor told the
    // operator to create a config file the runtime does not need, and exited 1.
    writeGlobal([{ id: 'default', botToken: 'bf_abcDEF123456' }], { sdk: { apiKey: 'sk-globalInlineKey' } })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.missing).toBe(0)
    expect(report.text).toContain('(from global config)')
    expect(report.text).not.toContain('NOT FOUND')
  })

  it('reports CONFIG BROKEN for a corrupt global config instead of idle-healthy', () => {
    writeFileSync(cfgPath, '{ not valid json', { mode: 0o600 })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('CONFIG BROKEN')
    expect(report.missing).toBe(1)
  })

  it('R6 B4: a declared-but-EMPTY sdk.env credential is NOT a usable source (false all-clear)', () => {
    // buildSdkEnv spreads the empty value over the inherited env → the
    // subprocess has no credential; doctor must count it as missing, not OK.
    writeGlobal([{ id: 'default' }], { sdk: { env: { ANTHROPIC_API_KEY: '' } } })
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, { ANTHROPIC_API_KEY: 'sk-inherited' }, NO_CREDS)
    expect(report.missing).toBe(1)
    expect(report.text).toContain('declared but EMPTY')
    expect(report.text).toContain('verdict: UNKNOWN (no usable auth source)')
  })
  it('R6 B4: an empty config credential hides an inherited fallback from the summary', () => {
    // Same shape as the reviewer's repro: config declares "" + a REAL inherited
    // ANTHROPIC_AUTH_TOKEN. The empty config value shadows it at runtime, so
    // attribution stays on config.env(empty) and the bot is missing.
    writeGlobal([{ id: 'default' }], { sdk: { env: { ANTHROPIC_API_KEY: '' } } })
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, { ANTHROPIC_AUTH_TOKEN: 'sk-inherited-token' }, NO_CREDS)
    expect(report.missing).toBe(1)
    expect(report.text).not.toContain('process.env')
  })

  it('treats an empty legacy default/config.json as idle, not a broken bot', () => {
    // Runtime: defaultPerBot.botToken falsy → resolveBotConfigs returns [] (idle).
    writeGlobal(undefined)
    mkdirSync(join(dir, 'default'), { recursive: true })
    writeFileSync(join(dir, 'default', 'config.json'), '{}', { mode: 0o600 })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('none configured')
    expect(report.missing).toBe(0)
  })

  it('does NOT fall back to an inline token when the per-bot file has an explicit empty botToken', () => {
    // Runtime: perBotFile.botToken = "" is a string → ?? does NOT fall through
    // → boot fails on the empty token. doctor must mirror that, not report OK.
    writeGlobal([{ id: 'default', botToken: 'bf_abcDEF123456' }])
    writeBot('default', { botToken: '' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('MISSING BOT TOKEN')
    expect(report.missing).toBe(1)
  })

  it('warns on an invalid inline bot id instead of following the path', () => {
    writeGlobal([{ id: '../escape' }])
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('invalid bot id')
    expect(report.missing).toBe(1)
  })

  it('reports CONFIG BROKEN for a corrupt per-bot file despite an inherited global key (r4 B2)', () => {
    // Runtime readConfigFile throws for the same file at boot; a global
    // sdk.apiKey must not turn this into verdict OK.
    writeGlobal([{ id: 'default', botToken: 'bf_abcDEF123456' }], { sdk: { apiKey: 'sk-globalKey12345' } })
    mkdirSync(join(dir, 'default'), { recursive: true })
    writeFileSync(join(dir, 'default', 'config.json'), '{ broken json', { mode: 0o600 })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('CONFIG BROKEN')
    expect(report.missing).toBe(1)
  })

  it('discovers bots[] entries without an id (runtime synthesizes bot0/bot1) (r4 B3)', () => {
    writeGlobal([{ botToken: 'bf_abcDEF123456' }])
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('bot "bot0"')
    expect(report.text).not.toContain('none configured')
    expect(report.missing).toBe(1) // the running bot0 has no auth source — not idle/exit 0
  })

  it('lists env var presence in the environment section', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-x' } })
    const report = doctorReport(cfgPath, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_MODEL: 'deepseek-v4' }, NO_CREDS)
    expect(report.text).toContain('ANTHROPIC_BASE_URL: https://gw.example.com')
    expect(report.text).toContain('ANTHROPIC_MODEL   : deepseek-v4')
  })
})

describe('runDoctor exit code (structured, not substring search)', () => {
  it('returns 0 when every bot is healthy', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-healthyKey123' } })
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(0)
  })
  it('returns 1 with a mixed healthy/unhealthy bot set (P1-3)', () => {
    writeGlobal([{ id: 'good' }, { id: 'bad' }])
    writeBot('good', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-goodKey12345' } })
    writeBot('bad', { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(1)
  })
  it('returns 1 when the only bot is unhealthy', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(1)
  })
  it('returns 0 for an uninitialized install (idle is not an auth failure)', () => {
    expect(runDoctor(join(dir, 'missing.json'), {}, NO_CREDS)).toBe(0)
  })
  it('returns 1 for the legacy top-level botToken shape without auth', () => {
    writeGlobal(undefined, { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(1)
  })
  it('returns 0 for an inline bots[].botToken + global sdk.apiKey, no per-bot dir', () => {
    writeGlobal([{ id: 'default', botToken: 'bf_abcDEF123456' }], { sdk: { apiKey: 'sk-globalInlineKey' } })
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(0)
  })
  it('returns 1 for an id-less bots[] entry with no auth (runtime runs it as bot0)', () => {
    writeGlobal([{ botToken: 'bf_abcDEF123456' }])
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(1)
  })
  it('does not read ambient host state (env OR ~/.claude credentials must not flip the verdict)', () => {
    // The reviewer's host had a real ~/.claude/.credentials.json, which
    // detectAuthSources picked up through the hard-wired DEFAULT_CREDENTIALS_PATH
    // and flipped these verdicts. credentialsPath is now injectable (P1-A).
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {}, NO_CREDS)).toBe(1)
  })
  it('still honors an EXPLICIT oauth-file credential when the bot has nothing else', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const creds = join(dir, '.credentials.json')
    writeFileSync(creds, '{"token":"x"}', { mode: 0o600 })
    expect(runDoctor(cfgPath, {}, creds)).toBe(0)
  })
})

describe('displayBaseUrl', () => {
  it('strips userinfo and path, keeping scheme://host (no credential leak)', () => {
    expect(displayBaseUrl('https://user:token@gw.example.com/v1')).toBe('https://gw.example.com')
    expect(displayBaseUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com')
  })
  it('masks an unparseable URL entirely', () => {
    expect(displayBaseUrl('not a url')).toBe('****')
  })
})

describe('listBotIds', () => {
  it('extracts ids from the bots[] array', () => {
    writeGlobal([{ id: 'default' }, { id: 'ops' }])
    expect(listBotIds(cfgPath)).toEqual(['default', 'ops'])
  })
  it('falls back to legacy default/ when bots[] is empty and default/config.json exists', () => {
    writeGlobal([])
    writeBot('default', { botToken: 'bf_x' })
    expect(listBotIds(cfgPath)).toEqual(['default'])
  })
  it('returns [] for a missing global config', () => {
    expect(listBotIds(join(dir, 'nope.json'))).toEqual([])
  })
})
