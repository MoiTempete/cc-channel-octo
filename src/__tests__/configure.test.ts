import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, configureFromClaude, normalizeGatewayUrl } from '../configure.js'

let dir: string
let cfgPath: string
let claudeSettingsPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccfg-'))
  cfgPath = join(dir, 'config.json')
  claudeSettingsPath = join(dir, 'claude-settings.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('configure', () => {
  it('creates a fresh config with sdk gateway + apiKey', () => {
    configure('https://gw.example.com', 'sk-test', cfgPath)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.sdk.anthropicBaseUrl).toBe('https://gw.example.com')
    expect(parsed.sdk.apiKey).toBe('sk-test')
  })
  it('merges into an existing config, preserving other fields', () => {
    writeFileSync(cfgPath, JSON.stringify({ apiUrl: 'https://octo.example.com', sdk: { model: 'claude-x', anthropicBaseUrl: 'https://old' } }))
    configure('https://new-gw', 'sk-new', cfgPath)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.apiUrl).toBe('https://octo.example.com')
    expect(parsed.sdk.model).toBe('claude-x')
    expect(parsed.sdk.anthropicBaseUrl).toBe('https://new-gw')
    expect(parsed.sdk.apiKey).toBe('sk-new')
  })
  it('writes the file mode 600', () => {
    configure('https://gw', 'sk', cfgPath)
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
  })
  it('creates the parent dir if missing', () => {
    const nested = join(dir, 'sub', 'config.json')
    configure('https://gw', 'sk', nested)
    expect(JSON.parse(readFileSync(nested, 'utf-8')).sdk.apiKey).toBe('sk')
  })
  it('throws on empty gatewayUrl or apiKey', () => {
    expect(() => configure('', 'sk', cfgPath)).toThrow()
    expect(() => configure('https://gw', '', cfgPath)).toThrow()
  })
  it('rejects an unsafe (non-http/https) gateway url', () => {
    expect(() => configure('ftp://gw', 'sk', cfgPath)).toThrow()
  })
  it('ensures final file mode is 0600 even when existing file has broader perms', () => {
    // Pre-create config with mode 0644
    writeFileSync(cfgPath, JSON.stringify({ sdk: {} }), { mode: 0o644 })
    configure('https://gw', 'sk-secret', cfgPath)
    const mode = statSync(cfgPath).mode & 0o777
    expect(mode).toBe(0o600)
    const content = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(content.sdk.apiKey).toBe('sk-secret')
  })
  it('throws a clear error when existing config root is not a plain object', () => {
    writeFileSync(cfgPath, JSON.stringify(null))
    expect(() => configure('https://gw', 'sk', cfgPath)).toThrow(/is not a JSON object/)
  })
  it('throws a clear error when existing config root is an array', () => {
    writeFileSync(cfgPath, JSON.stringify([1, 2, 3]))
    expect(() => configure('https://gw', 'sk', cfgPath)).toThrow(/is not a JSON object/)
  })
  it('throws a clear error when existing config root is a number', () => {
    writeFileSync(cfgPath, JSON.stringify(42))
    expect(() => configure('https://gw', 'sk', cfgPath)).toThrow(/is not a JSON object/)
  })
  it('strips a trailing /v1 from the stored gateway url', () => {
    configure('https://gw.test/v1', 'sk-test', cfgPath)
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).sdk.anthropicBaseUrl).toBe('https://gw.test')
  })
  it('writes sdk.model when a model is provided', () => {
    configure('https://gw.test', 'sk', cfgPath, { model: 'vertexai/claude-opus-4-8' })
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).sdk.model).toBe('vertexai/claude-opus-4-8')
  })
  it('PRESERVES an existing sdk.model when no model is provided', () => {
    writeFileSync(cfgPath, JSON.stringify({ sdk: { model: 'old/model' } }))
    configure('https://gw.test', 'sk', cfgPath) // no model → keep existing
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).sdk.model).toBe('old/model')
  })
  it('writes the top-level apiUrl when provided', () => {
    configure('https://gw.test', 'sk', cfgPath, { apiUrl: 'http://127.0.0.1:8090' })
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).apiUrl).toBe('http://127.0.0.1:8090')
  })
  it('rejects an unsafe --api-url', () => {
    expect(() => configure('https://gw.test', 'sk', cfgPath, { apiUrl: 'ftp://evil' })).toThrow()
  })
})

describe('configureFromClaude', () => {
  it('imports the ANTHROPIC_*/CLAUDE_CODE_* env block into sdk.env, mode 600', () => {
    writeFileSync(claudeSettingsPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-secretToken',
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-v4-flash[1M]',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
        MY_PERSONAL_VAR: 'do-not-import',
      },
    }))
    const result = configureFromClaude(claudeSettingsPath, cfgPath)
    expect(Object.keys(result.imported)).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'CLAUDE_CODE_EFFORT_LEVEL',
    ])
    expect(result.skipped).toEqual(['MY_PERSONAL_VAR'])
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.sdk.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secretToken')
    expect(parsed.sdk.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(parsed.sdk.env.MY_PERSONAL_VAR).toBeUndefined()
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
  })
  it('merges into an existing config, keeping existing sdk.env keys and other fields', () => {
    writeFileSync(cfgPath, JSON.stringify({ apiUrl: 'https://octo.example.com', sdk: { env: { OCTO_BOT_ID: 'x' } } }))
    writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-new' } }))
    configureFromClaude(claudeSettingsPath, cfgPath)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.apiUrl).toBe('https://octo.example.com')
    expect(parsed.sdk.env.OCTO_BOT_ID).toBe('x')
    expect(parsed.sdk.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-new')
  })
  it('throws a clear error when the settings file is missing', () => {
    expect(() => configureFromClaude(join(dir, 'nope.json'), cfgPath)).toThrow(/does not exist/)
  })
  it('throws when the env block is absent or empty of importable vars', () => {
    writeFileSync(claudeSettingsPath, JSON.stringify({ effortLevel: 'xhigh' }))
    expect(() => configureFromClaude(claudeSettingsPath, cfgPath)).toThrow(/no env block/)
    writeFileSync(claudeSettingsPath, JSON.stringify({ env: { FOO: 'bar' } }))
    expect(() => configureFromClaude(claudeSettingsPath, cfgPath)).toThrow(/no ANTHROPIC_\* \/ CLAUDE_CODE_\* env vars/)
  })
  it('applies the SSRF policy to the imported ANTHROPIC_BASE_URL', () => {
    writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://169.254.169.254' } }))
    expect(() => configureFromClaude(claudeSettingsPath, cfgPath)).toThrow(/unsafe ANTHROPIC_BASE_URL/)
    expect(existsSync(cfgPath)).toBe(false) // nothing written
    writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }))
    expect(() => configureFromClaude(claudeSettingsPath, cfgPath)).not.toThrow()
  })
  it('applies the SSRF policy to ANY imported *_URL / *_BASE_URL var', () => {
    writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_VERTEX_BASE_URL: 'http://169.254.169.254' } }))
    expect(() => configureFromClaude(claudeSettingsPath, cfgPath)).toThrow(/unsafe ANTHROPIC_VERTEX_BASE_URL/)
    expect(existsSync(cfgPath)).toBe(false)
  })
  it('flags baseUrlConflict when sdk.anthropicBaseUrl would shadow the imported base URL', () => {
    writeFileSync(cfgPath, JSON.stringify({ sdk: { anthropicBaseUrl: 'https://gw.example.com' } }))
    writeFileSync(claudeSettingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }))
    const result = configureFromClaude(claudeSettingsPath, cfgPath)
    expect(result.baseUrlConflict).toBe(true)
  })
})

describe('normalizeGatewayUrl', () => {
  it('strips a trailing /v1 or /v1/', () => {
    expect(normalizeGatewayUrl('https://gw.test/v1')).toBe('https://gw.test')
    expect(normalizeGatewayUrl('https://gw.test/v1/')).toBe('https://gw.test')
  })
  it('leaves a bare host or non-version path intact', () => {
    expect(normalizeGatewayUrl('https://gw.test')).toBe('https://gw.test')
    expect(normalizeGatewayUrl('https://gw.test/api')).toBe('https://gw.test/api')
  })
  it('does not strip a mid-path v1', () => {
    expect(normalizeGatewayUrl('https://gw.test/v1/foo')).toBe('https://gw.test/v1/foo')
  })
  it('strips a trailing /v1 case-insensitively and trims surrounding whitespace', () => {
    expect(normalizeGatewayUrl('https://gw.test/V1')).toBe('https://gw.test')
    expect(normalizeGatewayUrl('  https://gw.test/v1/  ')).toBe('https://gw.test')
  })
})
