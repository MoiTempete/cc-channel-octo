import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorReport, listBotIds, runDoctor } from '../doctor.js'

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
    expect(report.text).toContain('verdict: UNKNOWN (no static auth source)')
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
    expect(report.text).toContain('sdk: apiKey sk-gl****oken (base inherited by all bots)')
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

  it('reports an absent per-bot config as UNKNOWN/missing', () => {
    writeGlobal([{ id: 'default' }])
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report.text).toContain('NOT FOUND')
    expect(report.missing).toBe(1)
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
    expect(runDoctor(cfgPath, {})).toBe(0)
  })
  it('returns 1 with a mixed healthy/unhealthy bot set (P1-3)', () => {
    writeGlobal([{ id: 'good' }, { id: 'bad' }])
    writeBot('good', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-goodKey12345' } })
    writeBot('bad', { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {})).toBe(1)
  })
  it('returns 1 when the only bot is unhealthy', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {})).toBe(1)
  })
  it('returns 0 for an uninitialized install (idle is not an auth failure)', () => {
    expect(runDoctor(join(dir, 'missing.json'), {})).toBe(0)
  })
  it('does not read the ambient process env (host ANTHROPIC_API_KEY must not flip the verdict)', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    expect(runDoctor(cfgPath, {})).toBe(1) // env is injected as {} — no inherited key
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
