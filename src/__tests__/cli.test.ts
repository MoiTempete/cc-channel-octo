/**
 * cc CLI supervisor — unit tests for the pure helpers.
 *
 * Covers arg parsing, PID-file round-tripping, liveness probing, and path
 * resolution. The spawning commands (start/stop/restart) are intentionally not
 * exercised here — they fork a real process and belong in an integration test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs, isAlive, readPid, readPidRecord, writePid, removePid,
  resolveOwnedPid, resolveSupervisorPaths,
  readVersion, parseVersion, run, assertValidBotId, displayImportedValue,
} from '../cli.js';

describe('parseArgs', () => {
  it('defaults: no flags', () => {
    expect(parseArgs(['start'])).toEqual({ cmd: 'start', foreground: false, timeoutMs: 10_000, fromClaude: false });
  });

  it('empty argv yields empty cmd', () => {
    expect(parseArgs([])).toEqual({ cmd: '', foreground: false, timeoutMs: 10_000, fromClaude: false });
  });

  it('--foreground and -f both set foreground', () => {
    expect(parseArgs(['start', '--foreground']).foreground).toBe(true);
    expect(parseArgs(['start', '-f']).foreground).toBe(true);
  });

  it('--timeout=<n> overrides the stop timeout (seconds → ms)', () => {
    expect(parseArgs(['stop', '--timeout=30']).timeoutMs).toBe(30_000);
  });

  it('ignores a non-positive or non-numeric timeout', () => {
    expect(parseArgs(['stop', '--timeout=0']).timeoutMs).toBe(10_000);
    expect(parseArgs(['stop', '--timeout=abc']).timeoutMs).toBe(10_000);
  });

  it('parses --model (space and = forms)', () => {
    expect(parseArgs(['configure', '--model', 'm1']).model).toBe('m1');
    expect(parseArgs(['configure', '--model=m2']).model).toBe('m2');
  });

  it('parses --api-url (space and = forms)', () => {
    expect(parseArgs(['configure', '--api-url', 'http://127.0.0.1:8090']).apiUrl).toBe('http://127.0.0.1:8090');
    expect(parseArgs(['configure', '--api-url=https://octo.test']).apiUrl).toBe('https://octo.test');
  });

  it('throws when --model or --api-url is missing a value', () => {
    expect(() => parseArgs(['configure', '--model'])).toThrow(/--model requires a value/);
    expect(() => parseArgs(['configure', '--api-url', '--api-key=k'])).toThrow(/--api-url requires a value/);
  });

  it('parses --bot (space and = forms)', () => {
    expect(parseArgs(['configure', '--bot', 'default']).bot).toBe('default');
    expect(parseArgs(['configure', '--bot=ops']).bot).toBe('ops');
  });

  it('throws when --bot is missing a value', () => {
    expect(() => parseArgs(['configure', '--bot'])).toThrow(/--bot requires a value/);
  });

  it('parses --from-claude as a flag', () => {
    expect(parseArgs(['configure', '--from-claude']).fromClaude).toBe(true);
    expect(parseArgs(['configure']).fromClaude).toBe(false);
  });

  it('rejects a --bot that could escape baseDir (P1-1)', () => {
    for (const bad of ['../escaped', 'a/b', '.', '..', 'a\\b']) {
      expect(() => assertValidBotId(bad)).toThrow(/invalid --bot/);
    }
    expect(() => assertValidBotId('default')).not.toThrow();
    expect(() => assertValidBotId('ops-2.b')).not.toThrow();
  });
});

describe('displayImportedValue (allowlist masking)', () => {
  it('prints allowlisted model/effort vars verbatim', () => {
    expect(displayImportedValue('ANTHROPIC_MODEL', 'deepseek-v4-flash[1M]')).toBe('deepseek-v4-flash[1M]');
    expect(displayImportedValue('CLAUDE_CODE_EFFORT_LEVEL', 'max')).toBe('max');
  });
  it('masks everything else, incl. headers and URLs that could carry credentials', () => {
    const masked = displayImportedValue('ANTHROPIC_CUSTOM_HEADERS', 'Authorization: Bearer sk-secret-token');
    expect(masked).not.toContain('sk-secret-token');
    const urlMasked = displayImportedValue('ANTHROPIC_BASE_URL', 'https://user:pass@api.deepseek.com/anthropic');
    expect(urlMasked).not.toContain('user:pass');
    expect(displayImportedValue('ANTHROPIC_AUTH_TOKEN', 'sk-13def1b10d7c413c85fc3a8c0cd470fc')).toBe('sk-13****70fc');
  });
});

describe('isAlive', () => {
  it('returns true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('returns false for an unused PID', () => {
    // 2^31-1 is effectively never a live PID.
    expect(isAlive(2_147_483_647)).toBe(false);
  });

  it('returns false for invalid PIDs', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(1.5)).toBe(false);
  });
});

describe('PID file helpers', () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cli-'));
    pidFile = join(dir, 'cc-channel-octo.pid');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writePid → readPid round-trips', () => {
    writePid(pidFile, 12345, null);
    expect(readPid(pidFile)).toBe(12345);
  });

  it('writePid → readPidRecord preserves the owner identity', () => {
    writePid(pidFile, 12345, 'Tue Jun 17 18:35:01 2026');
    expect(readPidRecord(pidFile)).toEqual({ pid: 12345, id: 'Tue Jun 17 18:35:01 2026' });
  });

  it('readPidRecord reads a legacy bare-integer file as a null identity', () => {
    writeFileSync(pidFile, '4242\n');
    expect(readPidRecord(pidFile)).toEqual({ pid: 4242, id: null });
    expect(readPid(pidFile)).toBe(4242);
  });

  it('readPid returns null when the file is missing', () => {
    expect(readPid(pidFile)).toBeNull();
  });

  it('readPid returns null for garbage content', () => {
    writeFileSync(pidFile, 'not-a-pid\n');
    expect(readPid(pidFile)).toBeNull();
    expect(readPidRecord(pidFile)).toBeNull();
  });

  it('removePid deletes the file and is a no-op when absent', () => {
    writePid(pidFile, 999, null);
    removePid(pidFile);
    expect(existsSync(pidFile)).toBe(false);
    expect(() => removePid(pidFile)).not.toThrow();
  });
});

describe('resolveOwnedPid (PID-reuse guard)', () => {
  let dir: string;
  let paths: ReturnType<typeof resolveSupervisorPaths>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cli-own-'));
    paths = resolveSupervisorPaths(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the PID when alive and the identity matches', () => {
    writePid(paths.pidFile, process.pid, 'IDENT-A');
    expect(resolveOwnedPid(paths, () => 'IDENT-A')).toBe(process.pid);
  });

  it('returns null and clears the file when the identity mismatches (PID reused)', () => {
    writePid(paths.pidFile, process.pid, 'IDENT-A');
    expect(resolveOwnedPid(paths, () => 'IDENT-B')).toBeNull();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('falls back to liveness only for a legacy file (null identity)', () => {
    writeFileSync(paths.pidFile, `${process.pid}\n`);
    // procId would say "mismatch", but a legacy file has nothing to verify.
    expect(resolveOwnedPid(paths, () => 'anything')).toBe(process.pid);
  });

  it('falls back to liveness only when the live identity is unreadable', () => {
    writePid(paths.pidFile, process.pid, 'IDENT-A');
    expect(resolveOwnedPid(paths, () => null)).toBe(process.pid);
  });

  it('returns null and clears the file when the PID is dead', () => {
    writePid(paths.pidFile, 2_147_483_647, 'IDENT-A');
    expect(resolveOwnedPid(paths, () => 'IDENT-A')).toBeNull();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it('returns null when there is no PID file', () => {
    expect(resolveOwnedPid(paths, () => 'IDENT-A')).toBeNull();
  });
});

describe('resolveSupervisorPaths', () => {
  it('derives pid/log under an injected baseDir', () => {
    const p = resolveSupervisorPaths('/tmp/base');
    expect(p.baseDir).toBe('/tmp/base');
    expect(p.pidFile).toBe('/tmp/base/cc-channel-octo.pid');
    expect(p.logFile).toBe('/tmp/base/logs/gateway.log');
    expect(p.indexEntry).toMatch(/index\.js$/);
  });

  it('defaults baseDir to the global config directory', () => {
    const p = resolveSupervisorPaths();
    expect(p.pidFile).toMatch(/\.cc-channel-octo\/cc-channel-octo\.pid$/);
  });
});

describe('parseVersion', () => {
  it('extracts a string version', () => {
    expect(parseVersion('{"version":"1.2.3"}')).toBe('1.2.3');
  });
  it('falls back to "unknown" on malformed JSON', () => {
    expect(parseVersion('not json')).toBe('unknown');
  });
  it('falls back to "unknown" when version is missing', () => {
    expect(parseVersion('{"name":"x"}')).toBe('unknown');
  });
  it('falls back to "unknown" when version is not a string', () => {
    expect(parseVersion('{"version":123}')).toBe('unknown');
  });
  it('falls back to "unknown" on an empty version string', () => {
    expect(parseVersion('{"version":""}')).toBe('unknown');
  });
});

describe('readVersion', () => {
  it('returns the version from the real package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });
});

describe('parseArgs configure', () => {
  it('parses --gateway-url and --api-key (space form)', () => {
    const a = parseArgs(['configure', '--gateway-url', 'https://gw', '--api-key', 'sk-1'])
    expect(a.cmd).toBe('configure'); expect(a.gatewayUrl).toBe('https://gw'); expect(a.apiKey).toBe('sk-1')
  })
  it('parses = form', () => {
    const a = parseArgs(['configure', '--gateway-url=https://gw', '--api-key=sk-2'])
    expect(a.gatewayUrl).toBe('https://gw'); expect(a.apiKey).toBe('sk-2')
  })
  it('throws when --gateway-url value is missing', () => {
    expect(() => parseArgs(['configure', '--gateway-url'])).toThrow(/requires a value/)
  })
  it('throws when --gateway-url value is another flag', () => {
    expect(() => parseArgs(['configure', '--gateway-url', '--api-key', 'sk'])).toThrow(/requires a value/)
  })
  it('throws when --api-key value is missing', () => {
    expect(() => parseArgs(['configure', '--api-key'])).toThrow(/requires a value/)
  })
  it('throws when --api-key value is another flag', () => {
    expect(() => parseArgs(['configure', '--api-key', '--gateway-url', 'https://gw'])).toThrow(/requires a value/)
  })
})

describe('run configure with env var fallback', () => {
  let dir: string;
  let cfgPath: string;
  // Snapshot ALL credential-ish env so a developer machine exporting
  // ANTHROPIC_API_KEY (exactly the setup this feature targets) can't leak a
  // real key into a temp config.json or flip these assertions (P1-4).
  const originalEnv = {
    CC_OCTO_CONFIGURE_API_KEY: process.env.CC_OCTO_CONFIGURE_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cli-cfg-'));
    cfgPath = join(dir, 'config.json');
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  it('reads API key from CC_OCTO_CONFIGURE_API_KEY when --api-key is absent', async () => {
    process.env.CC_OCTO_CONFIGURE_API_KEY = 'sk-from-env';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run(['configure', '--gateway-url', 'https://gw'], dir);
      expect(code).toBe(0);
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      expect(parsed.sdk.apiKey).toBe('sk-from-env');
      expect(parsed.sdk.anthropicBaseUrl).toBe('https://gw');
    } finally {
      spy.mockRestore();
    }
  });

  it('CLI --api-key flag takes precedence over env var', async () => {
    process.env.CC_OCTO_CONFIGURE_API_KEY = 'sk-from-env';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run(['configure', '--gateway-url', 'https://gw', '--api-key', 'sk-from-cli'], dir);
      expect(code).toBe(0);
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      expect(parsed.sdk.apiKey).toBe('sk-from-cli');
    } finally {
      spy.mockRestore();
    }
  });

  it('exits 2 when both --api-key and env var are missing', async () => {
    delete process.env.CC_OCTO_CONFIGURE_API_KEY;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await run(['configure', '--gateway-url', 'https://gw'], dir);
      expect(code).toBe(2);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('required'));
    } finally {
      spy.mockRestore();
    }
  });

  it('does NOT harvest an ambient ANTHROPIC_API_KEY off-TTY (no silent secret persist)', async () => {
    // The ANTHROPIC_API_KEY fallback requires an explicit yes on a TTY; under
    // vitest stdin is not a TTY, so the key must be left alone and the command
    // must fail with the required-key error instead of writing it to disk.
    delete process.env.CC_OCTO_CONFIGURE_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-do-not-persist-me';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run(['configure', '--gateway-url', 'https://gw'], dir);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('required'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('configured gateway'));
      expect(existsSync(cfgPath)).toBe(false); // nothing written
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('exits 2 (not an unhandled throw) when a flag is missing its value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // parseArgs throws on `--gateway-url` with no value; run() must map that
      // to a usage exit code rather than letting it escape to the top-level catch.
      const code = await run(['configure', '--gateway-url'], dir);
      expect(code).toBe(2);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('requires a value'));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('run version command', () => {
  it.each(['version', '--version', '-v'])('prints bare version and exits 0 for %s', async (arg) => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run([arg]);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledWith(readVersion());
    } finally {
      spy.mockRestore();
    }
  });
});
