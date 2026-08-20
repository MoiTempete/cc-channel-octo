/**
 * `doctor` subcommand backend — static Claude authentication diagnosis.
 *
 * Independent of loadConfig(): loadConfig requires a valid apiUrl and merges
 * strict defaults, while doctor must report on a BROKEN or half-configured
 * install (that's exactly when it's run). So this reads the config JSON files
 * raw, mirroring the Q12 permission check from config.ts for every file it
 * touches, and never makes network calls or spawns the SDK.
 *
 * Output is a plain text report; the CLI prints it and maps the verdict to an
 * exit code (0 = every bot has a Claude auth source, 1 = something missing).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG_PATH } from './config.js';
import {
  detectAuthSources,
  maskKey,
  DEFAULT_CREDENTIALS_PATH,
  type SdkAuthInput,
  type AuthSourceInfo,
} from './auth-detect.js';

/** The env vars doctor reports on. Injectable for tests. */
export interface DoctorEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
}

/** Octal mode string ('600') of a path, or null when it doesn't exist. */
function fileMode(path: string): string | null {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return null;
  }
}

/** Q12-style warning suffix when group/other bits are set on a config file. */
function permissionNote(mode: string | null): string {
  if (!mode || mode.length !== 3) return '';
  const groupOrOther = Number.parseInt(mode[1], 10) > 0 || Number.parseInt(mode[2], 10) > 0;
  return groupOrOther ? ' (WARNING: group/other readable — fix with chmod 600)' : '';
}

/** bot ids from the global config's bots[]; legacy default/ fallback. */
export function listBotIds(globalConfigPath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      const bots = (parsed as { bots?: unknown }).bots;
      if (Array.isArray(bots)) {
        const ids = bots
          .map((b) => (b && typeof b === 'object' && typeof (b as { id?: unknown }).id === 'string'
            ? ((b as { id: string }).id)
            : null))
          .filter((id): id is string => id !== null && id.length > 0);
        if (ids.length > 0) return ids;
      }
    }
  } catch {
    /* unparseable/missing → fall through to legacy check below */
  }
  // Legacy single-bot install: token lives only in <baseDir>/default/config.json.
  return existsSync(join(dirname(globalConfigPath), 'default', 'config.json')) ? ['default'] : [];
}

/** Narrow raw JSON into the sdk fields auth detection reads. */
function narrowSdk(raw: unknown): SdkAuthInput {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const s = raw as { apiKey?: unknown; env?: unknown };
    const apiKey = typeof s.apiKey === 'string' ? s.apiKey : undefined;
    const env =
      s.env && typeof s.env === 'object' && !Array.isArray(s.env)
        ? (s.env as Record<string, string>)
        : undefined;
    return { apiKey, env };
  }
  return {};
}

/**
 * Read a config file's sdk block + botToken. The sdk block is the MERGED view
 * a running bot actually uses: the global `sdk` block is the base, per-bot
 * fields override it shallowly (same semantics as mergeConfig in config.ts) —
 * so an apiKey configured in the GLOBAL config.json counts for every bot that
 * doesn't override it, exactly as at runtime.
 */
function readSdkAndToken(path: string): { sdk: SdkAuthInput; botToken: string; botHasOwnSdk: boolean } {
  let sdk: SdkAuthInput = {};
  let botToken = '';
  let botHasOwnSdk = false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      const raw = parsed as { botToken?: unknown; sdk?: unknown };
      if (typeof raw.botToken === 'string') botToken = raw.botToken;
      if (raw.sdk && typeof raw.sdk === 'object' && !Array.isArray(raw.sdk)) {
        const own = narrowSdk(raw.sdk);
        botHasOwnSdk = own.apiKey !== undefined || (own.env !== undefined && Object.keys(own.env).length > 0);
        sdk = own;
      }
    }
  } catch {
    /* unparseable — caller reports the failure */
  }
  return { sdk, botToken, botHasOwnSdk };
}

/** Merge a global sdk base with a per-bot override (shallow, per-bot wins). */
function mergeSdk(globalSdk: SdkAuthInput, botSdk: SdkAuthInput): SdkAuthInput {
  return { ...globalSdk, ...botSdk };
}

function describeSources(sources: AuthSourceInfo[]): string {
  if (sources.length === 0) return 'MISSING — first message will fail with "Not logged in"';
  return sources.map((s) => (s.masked ? `${s.kind} (${s.masked})` : s.kind)).join(', ');
}

/**
 * Build the full doctor report. Pure (paths + env injected) so the text is
 * unit-testable against a temp fixture, like configure.test.ts.
 */
export function doctorReport(
  configPath: string = DEFAULT_CONFIG_PATH,
  baseEnv: NodeJS.ProcessEnv = process.env,
  credentialsPath: string = DEFAULT_CREDENTIALS_PATH,
): string {
  const lines: string[] = [];
  lines.push('cc-channel-octo doctor — Claude authentication diagnosis');
  lines.push('');

  // --- Global config ---
  lines.push(`global config: ${configPath}`);
  if (!existsSync(configPath)) {
    lines.push('  NOT FOUND — bootstrap with `npm run configure -- --gateway-url <url> --api-key <key>` (source) / `cc-channel-octo configure --gateway-url <url> --api-key <key>` (global)');
    lines.push('  (bot tokens then go into ~/.cc-channel-octo/<id>/config.json)');
    lines.push('');
    lines.push('verdict: NOT INITIALIZED');
    return lines.join('\n');
  }
  lines.push(`  mode ${fileMode(configPath) ?? '?'}${permissionNote(fileMode(configPath))}`);

  // The global `sdk` block is the BASE every bot inherits (per-bot overrides
  // shallowly, same as mergeConfig at runtime) — an apiKey configured here
  // counts for every bot that doesn't override it, so it must feed detection.
  let globalSdk: SdkAuthInput = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      globalSdk = narrowSdk((parsed as { sdk?: unknown }).sdk);
    }
  } catch {
    /* unparseable — listBotIds reports the shape; detection just sees no sdk */
  }
  const globalAuth = globalSdk.apiKey
    ? `apiKey ${maskKey(globalSdk.apiKey)}`
    : globalSdk.env?.ANTHROPIC_API_KEY
      ? `env.ANTHROPIC_API_KEY ${maskKey(globalSdk.env.ANTHROPIC_API_KEY)}`
      : 'unset';
  lines.push(`  sdk: ${globalAuth} (base inherited by all bots)`);

  // --- Per-bot diagnosis ---
  const botIds = listBotIds(configPath);
  const baseDir = dirname(configPath);
  let missing = 0;
  if (botIds.length === 0) {
    lines.push('bots: none configured (idle state — awaiting provision)');
  } else {
    for (const botId of botIds) {
      const botCfgPath = join(baseDir, botId, 'config.json');
      lines.push(`bot "${botId}"`);
      lines.push(`  config: ${botCfgPath}`);
      if (!existsSync(botCfgPath)) {
        lines.push('  NOT FOUND — create it with a botToken (and optional sdk block)');
        lines.push('  Claude auth: MISSING');
        lines.push('  verdict: MISSING AUTH');
        missing++;
        continue;
      }
      const mode = fileMode(botCfgPath);
      lines.push(`  mode ${mode ?? '?'}${permissionNote(mode)}`);
      const { sdk: botSdk, botToken, botHasOwnSdk } = readSdkAndToken(botCfgPath);
      lines.push(`  botToken: ${botToken ? maskKey(botToken) : 'MISSING'}`);
      const sources = detectAuthSources(mergeSdk(globalSdk, botSdk), baseEnv, credentialsPath);
      const originNote = sources.length > 0 && !botHasOwnSdk ? ' (from global config)' : '';
      lines.push(`  Claude auth: ${describeSources(sources)}${originNote}`);
      if (sources.length === 0) {
        lines.push('  verdict: MISSING AUTH');
        missing++;
      } else {
        lines.push('  verdict: OK');
      }
    }
  }
  lines.push('');

  // --- Environment ---
  const env = baseEnv as DoctorEnv;
  lines.push('environment');
  lines.push(`  ANTHROPIC_API_KEY : ${env.ANTHROPIC_API_KEY ? `${maskKey(env.ANTHROPIC_API_KEY)} (inherited into the SDK subprocess)` : 'unset'}`);
  lines.push(`  ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL ?? 'unset'}`);
  lines.push(`  ANTHROPIC_MODEL   : ${env.ANTHROPIC_MODEL ?? 'unset'}`);
  lines.push(`  OAuth login file  : ${credentialsPath} — ${existsSync(credentialsPath) ? 'present' : 'absent (macOS Keychain login is not statically detectable)'}`);
  lines.push('');

  // --- Verdict + guidance ---
  if (missing > 0) {
    lines.push(`verdict: ${missing} bot(s) without Claude authentication. Fix with one of:`);
    lines.push('  - `npm run setup` (source) / `cc-channel-octo configure --from-claude` (global) — import the env block of ~/.claude/settings.json (token + base URL + model mapping); add `-- --bot <id>` / `--bot <id>` for a per-bot config');
    lines.push('  - `cc-channel-octo configure --gateway-url <url> --api-key <key>` (writes sdk.apiKey; key also via CC_OCTO_CONFIGURE_API_KEY)');
    lines.push('  - add sdk.apiKey or sdk.env to the bot\'s config.json (chmod 600)');
    lines.push('  - export ANTHROPIC_API_KEY in the shell that starts the gateway');
    lines.push('  - run `claude` + `/login` on this host (OAuth)');
  } else if (botIds.length === 0) {
    lines.push('verdict: NO BOTS — configure bots before worrying about authentication');
  } else {
    lines.push('verdict: OK — every bot has a Claude authentication source');
  }
  return lines.join('\n');
}

/** Run doctor: print the report, return the process exit code. */
export function runDoctor(configPath?: string): number {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const report = doctorReport(path, process.env, DEFAULT_CREDENTIALS_PATH);
  console.log(report);
  return report.includes('verdict: OK') ? 0 : 1;
}
