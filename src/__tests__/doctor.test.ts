import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorReport, listBotIds } from '../doctor.js'

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
    expect(report).toContain('NOT FOUND')
    expect(report).toContain('verdict: NOT INITIALIZED')
  })

  it('verdict OK when a bot has sdk.apiKey; masks the key in the report', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-topSecretValue' } })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report).toContain('verdict: OK')
    expect(report).toContain('sk-to****alue') // masked, never the full key
    expect(report).not.toContain('sk-topSecretValue')
  })

  it('flags MISSING AUTH when a bot has no source at all', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report).toContain('MISSING AUTH')
    expect(report).toContain('verdict: 1 bot(s) without Claude authentication')
    expect(report).toContain('npm run setup') // the first suggested fix
  })

  it('accepts an inherited ANTHROPIC_API_KEY from the process env', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, { ANTHROPIC_API_KEY: 'sk-inheritedKey' }, NO_CREDS)
    expect(report).toContain('verdict: OK')
    expect(report).toContain('process.env')
  })

  it('counts a GLOBAL sdk.apiKey for bots that do not override it (runtime merge semantics)', () => {
    // configure writes to the global config by default — a bot with only a
    // botToken still authenticates via the inherited global sdk block.
    writeGlobal([{ id: 'default' }], { sdk: { apiKey: 'sk-globalSecretKey' } })
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report).toContain('verdict: OK')
    expect(report).toContain('(from global config)')
    expect(report).toContain('sk-gl****tKey') // masked
    expect(report).not.toContain('sk-globalSecretKey')
  })

  it('reports a global sdk summary line', () => {
    writeGlobal([{ id: 'default' }], { sdk: { apiKey: 'sk-globalSummaryKey' } })
    writeBot('default', { botToken: 'bf_abcDEF123456' })
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report).toContain('sdk: apiKey sk-gl****yKey (base inherited by all bots)')
  })

  it('warns when a config file is group/other readable', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-x' } })
    chmodSync(cfgPath, 0o644)
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report).toContain('group/other readable')
  })

  it('reports an absent per-bot config as MISSING AUTH', () => {
    writeGlobal([{ id: 'default' }])
    const report = doctorReport(cfgPath, {}, NO_CREDS)
    expect(report).toContain('NOT FOUND')
    expect(report).toContain('MISSING AUTH')
  })

  it('lists env var presence in the environment section', () => {
    writeGlobal([{ id: 'default' }])
    writeBot('default', { botToken: 'bf_abcDEF123456', sdk: { apiKey: 'sk-x' } })
    const report = doctorReport(cfgPath, { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_MODEL: 'deepseek-v4' }, NO_CREDS)
    expect(report).toContain('ANTHROPIC_BASE_URL: https://gw.example.com')
    expect(report).toContain('ANTHROPIC_MODEL   : deepseek-v4')
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
