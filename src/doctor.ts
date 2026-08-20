/**
 * `doctor` subcommand backend — static Claude authentication diagnosis.
 *
 * Independent of loadConfig(): loadConfig requires a valid apiUrl and merges
 * strict defaults, while doctor must report on a BROKEN or half-configured
 * install (that's exactly when it's run). So this reads the config JSON files
 * raw, mirroring the Q12 permission check from config.ts for every file it
 * touches, and never makes network calls or spawns the SDK.
 *
 * The report builder returns a STRUCTURED result ({ text, missing, hasBots })
 * so the exit code comes from data, never from re-parsing prose.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG_PATH } from './config.js';
import {
  detectAuthSources,
  hasUsableAuthSource,
  maskKey,
  displayBaseUrl,
  KEY_ENV_VARS,
  DEFAULT_CREDENTIALS_PATH,
  type SdkAuthInput,
  type AuthSourceInfo,
} from './auth-detect.js';

/** The env vars doctor reports on. Injectable for tests. */
export interface DoctorEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
}

/** Structured doctor result: the report text plus the numbers that drive exit codes. */
export interface DoctorReport {
  text: string;
  /** Bots with no statically detectable auth source (incl. UNKNOWN cases). */
  missing: number;
  /** True when the install declares at least one bot. */
  hasBots: boolean;
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


/** One bot entry as the runtime sees it: global → inline bots[] → per-bot file. */
export interface DoctorBotEntry {
  id: string;
  /** botToken from the global config (top-level legacy field or inline bots[] entry). */
  inlineBotToken?: string;
}

/** Parsed global config: the layers doctor must model like resolveBotConfigs(). */
interface GlobalConfigShape {
  /** Legacy top-level botToken (single-bot install, no bots[]). */
  topLevelBotToken?: string;
  /** bots[] entries (each may carry an inline botToken). */
  entries: DoctorBotEntry[];
  /** Global sdk block — the base every bot inherits. */
  sdk: SdkAuthInput;
  /** True when the file exists but failed to parse — a broken install, not idle. */
  broken?: string;
}

/**
 * Parse the global config with the SAME discovery rules as resolveBotConfigs():
 *   - bots[] present → those entries (inline botToken is explicitly supported)
 *   - bots[] absent + top-level botToken → synthesize { id: 'default' } (legacy)
 *   - bots[] absent + no top-level token + default/config.json exists → 'default'
 *   - otherwise → no bots (idle)
 * `missing`/exit codes are only trustworthy if doctor discovers the same bots
 * the runtime would actually run.
 */
function parseGlobalConfig(configPath: string): GlobalConfigShape {
  const baseDir = dirname(configPath);
  let topLevelBotToken: string | undefined;
  let bots: unknown[] = [];
  let sdkRaw: unknown;
  let broken: string | undefined;
  if (existsSync(configPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        const p = parsed as { botToken?: unknown; bots?: unknown; sdk?: unknown };
        if (typeof p.botToken === 'string') topLevelBotToken = p.botToken;
        if (Array.isArray(p.bots)) bots = p.bots;
        sdkRaw = p.sdk;
      } else {
        broken = 'config root is not a JSON object';
      }
    } catch (err) {
      // A BROKEN config is exactly when doctor is run — reporting it as
      // "idle, healthy" (exit 0) would be a false all-clear (runtime throws
      // "Failed to parse config file" at boot).
      broken = err instanceof Error ? err.message : String(err);
    }
  }
  let entries: DoctorBotEntry[] = [];
  if (bots.length > 0) {
    bots.forEach((b, i) => {
      // resolveBotConfigs synthesizes `bot.id ?? \`bot${i}\`` — an entry
      // without an id RUNS as bot0/bot1 at runtime, so doctor must discover it
      // too (a bot0 with no auth source would otherwise report idle + exit 0).
      const bb = b && typeof b === 'object' ? (b as { id?: unknown; botToken?: unknown }) : null;
      entries.push({
        // `??`, not truthiness (R7 P2): runtime uses `bot.id ?? \`bot${i}\`` —
        // an explicit EMPTY string stays "" and then fails the slug check at
        // boot; doctor must surface that as an invalid id, not synthesize bot0.
        id: bb && typeof bb.id === 'string' ? bb.id : `bot${i}`,
        inlineBotToken: bb && typeof bb.botToken === 'string' ? bb.botToken : undefined,
      });
    });
  } else if (topLevelBotToken !== undefined) {
    // Legacy single-bot: resolveBotConfigs synthesizes { id: 'default', botToken }.
    entries = [{ id: 'default', inlineBotToken: topLevelBotToken }];
  } else {
    // Legacy single-bot whose token lives only in the per-bot file — the
    // runtime requires that file to actually carry a token before synthesizing
    // 'default' (an empty file means idle, not a broken bot); a corrupt file is
    // discovered so the per-bot section can report CONFIG BROKEN.
    const legacyFile = join(baseDir, 'default', 'config.json');
    if (existsSync(legacyFile)) {
      const legacy = readSdkAndToken(legacyFile);
      if (legacy.parseError !== undefined || legacy.botToken) {
        entries = [{ id: 'default' }];
      }
    }
  }
  return { topLevelBotToken, entries, sdk: narrowSdk(sdkRaw), broken };
}

/** bot ids from the global config (same discovery rules as resolveBotConfigs). */
export function listBotIds(globalConfigPath: string): string[] {
  return parseGlobalConfig(globalConfigPath).entries.map((e) => e.id);
}

/**
 * Narrow raw JSON into the sdk fields auth detection reads. Only DEFINED
 * fields are copied: config.ts merges raw JSON.parse output (which never
 * contains explicit `undefined` keys), so materialising `apiKey: undefined`
 * here would wipe an inherited global value on spread (P1-2).
 */
function narrowSdk(raw: unknown): SdkAuthInput {
  const out: SdkAuthInput = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const s = raw as { apiKey?: unknown; env?: unknown };
    if (typeof s.apiKey === 'string') out.apiKey = s.apiKey;
    if (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) {
      out.env = s.env as Record<string, string>;
    }
  }
  return out;
}

/**
 * Read a config file's sdk block + botToken. The sdk block is the MERGED view
 * a running bot actually uses: the global `sdk` block is the base, per-bot
 * fields override it shallowly (same semantics as mergeConfig in config.ts) —
 * so an apiKey configured in the GLOBAL config.json counts for every bot that
 * doesn't override it, exactly as at runtime.
 */
function readSdkAndToken(path: string): {
  sdk: SdkAuthInput;
  botToken: string | undefined;
  botHasOwnSdk: boolean;
  /** Set when the file exists but fails to parse — the runtime THROWS at boot. */
  parseError?: string;
} {
  let sdk: SdkAuthInput = {};
  // undefined (NOT '') when absent: `??` in the caller must fall through to the
  // inline/top-level token exactly like config.ts's perBotFile.botToken ?? bot.botToken.
  let botToken: string | undefined;
  let botHasOwnSdk = false;
  let parseError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      const raw = parsed as { botToken?: unknown; sdk?: unknown };
      // Any explicit string — including "" — is a value: config.ts merges with
      // `??`, and "" never falls through to the inline/top-level token (the
      // runtime then fails boot on the empty token; doctor must say so too).
      if (typeof raw.botToken === 'string') botToken = raw.botToken;
      if (raw.sdk && typeof raw.sdk === 'object' && !Array.isArray(raw.sdk)) {
        const own = narrowSdk(raw.sdk);
        // P2-10: only a CREDENTIAL counts as "own sdk" for the origin label —
        // a per-bot env with just ANTHROPIC_MODEL inherits the global key and
        // must still be labelled "(from global config)".
        botHasOwnSdk =
          own.apiKey !== undefined ||
          (own.env !== undefined &&
            KEY_ENV_VARS.some((k) => Object.prototype.hasOwnProperty.call(own.env, k)));
        sdk = own;
      }
    }
  } catch (err) {
    // A corrupt per-bot config is exactly when doctor is run: reporting OK
    // (auth inherited from the global sdk) would be a false all-clear, because
    // the runtime's readConfigFile THROWS "Failed to parse config file" for the
    // same file and the bot never starts (r4 B2).
    parseError = err instanceof Error ? err.message : String(err);
  }
  return { sdk, botToken, botHasOwnSdk, parseError };
}

/** Merge a global sdk base with a per-bot override (shallow, per-bot wins). */
function mergeSdk(globalSdk: SdkAuthInput, botSdk: SdkAuthInput): SdkAuthInput {
  const merged: SdkAuthInput = {};
  // Only copy defined fields — a per-bot sdk block that sets `model` alone must
  // NOT wipe the inherited global apiKey/env (mirrors config.ts:683-688).
  if (globalSdk.apiKey !== undefined) merged.apiKey = globalSdk.apiKey;
  if (globalSdk.env !== undefined) merged.env = globalSdk.env;
  if (botSdk.apiKey !== undefined) merged.apiKey = botSdk.apiKey;
  if (botSdk.env !== undefined) merged.env = botSdk.env;
  return merged;
}

/** First credential value across the accepted env var names (mirrors auth-detect). */
function firstCredential(env: Record<string, string> | undefined): string | undefined {
  if (!env) return undefined;
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
    const v = env[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Human summary of the auth sources, including the Keychain-hedged wording:
 * no static source does NOT prove the bot is broken (macOS Keychain-only OAuth
 * is undetectable), so doctor says UNKNOWN rather than asserting failure.
 */
function describeSources(sources: AuthSourceInfo[]): string {
  if (sources.length === 0) {
    return 'UNKNOWN — no static auth source (macOS Keychain-only OAuth is not statically detectable; verify with `claude auth status`)';
  }
  return sources
    .map((s) => (s.empty ? s.describe : s.masked ? `${s.kind} (${s.masked})` : s.kind))
    .join(', ');
}

/**
 * Build the full doctor report. Pure (paths + env injected) so the text is
 * unit-testable against a temp fixture, like configure.test.ts. Returns a
 * structured result — the exit code MUST come from `missing`, never from a
 * substring search of the prose (P1-3).
 */
export function doctorReport(
  configPath: string = DEFAULT_CONFIG_PATH,
  baseEnv: NodeJS.ProcessEnv = process.env,
  credentialsPath: string = DEFAULT_CREDENTIALS_PATH,
): DoctorReport {
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
    return { text: lines.join('\n'), missing: 0, hasBots: false };
  }
  lines.push(`  mode ${fileMode(configPath) ?? '?'}${permissionNote(fileMode(configPath))}`);

  // Parse the global config with the same discovery rules as resolveBotConfigs()
  // (top-level botToken / inline bots[] / per-bot file) so doctor diagnoses the
  // bots the runtime would ACTUALLY run.
  const global = parseGlobalConfig(configPath);
  if (global.broken !== undefined) {
    lines.push(`  PARSE ERROR: ${global.broken} — the runtime would fail to boot`);
    lines.push('');
    lines.push('verdict: CONFIG BROKEN — fix the JSON, then re-run doctor');
    return { text: lines.join('\n'), missing: 1, hasBots: false };
  }
  const globalSdk = global.sdk;
  const globalCredential = globalSdk.apiKey ?? firstCredential(globalSdk.env);
  const globalAuth = globalCredential
    ? `credential ${maskKey(globalCredential)}`
    : 'unset';
  lines.push(`  sdk: ${globalAuth} (base inherited by all bots)`);

  // --- Per-bot diagnosis ---
  const baseDir = dirname(configPath);
  let missing = 0;
  if (global.entries.length === 0) {
    lines.push('bots: none configured (idle state — awaiting provision)');
  } else {
    for (const entry of global.entries) {
      const botId = entry.id;
      // A bad inline id (../x, a/b) would make join() read OUTSIDE baseDir;
      // the runtime rejects such ids at boot — warn instead of following the path.
      if (!/^[a-zA-Z0-9._-]+$/.test(botId) || botId === '.' || botId === '..') {
        lines.push(`bot "${botId}"`);
        lines.push(`  WARNING: invalid bot id — the runtime would reject this config (use letters, digits, dot, underscore, hyphen)`);
        missing++;
        continue;
      }
      const botCfgPath = join(baseDir, botId, 'config.json');
      lines.push(`bot "${botId}"`);
      lines.push(`  config: ${botCfgPath}`);
      // Three-layer token resolution, matching config.ts:638
      // (perBotFile.botToken ?? bot.botToken). A missing per-bot FILE is fine
      // when the token comes from the global config — the runtime needs no
      // file then, and telling the operator to create one is a false alarm.
      let fileSdk: SdkAuthInput = {};
      let fileToken: string | undefined;
      let fileHasOwnSdk = false;
      if (existsSync(botCfgPath)) {
        const mode = fileMode(botCfgPath);
        lines.push(`  mode ${mode ?? '?'}${permissionNote(mode)}`);
        const r = readSdkAndToken(botCfgPath);
        if (r.parseError !== undefined) {
          // Same false-all-clear class as the corrupt GLOBAL config: the
          // runtime's readConfigFile throws for this file, so the bot never
          // starts — an inherited global key must NOT turn this into verdict OK.
          lines.push(`  PARSE ERROR: ${r.parseError} — the runtime would fail to boot this bot`);
          lines.push('  verdict: CONFIG BROKEN');
          missing++;
          continue;
        }
        fileSdk = r.sdk;
        fileToken = r.botToken;
        fileHasOwnSdk = r.botHasOwnSdk;
      } else {
        lines.push('  (no per-bot config.json — token may come from the global config)');
      }
      const token = fileToken ?? entry.inlineBotToken ?? '';
      const tokenNote = !fileToken && entry.inlineBotToken ? ' (from global config)' : '';
      lines.push(`  botToken: ${token ? `${maskKey(token)}${tokenNote}` : 'MISSING'}`);
      if (!token) {
        lines.push(`  NOT FOUND — set botToken in ${botCfgPath} or inline (bots[].botToken / top-level botToken)`);
        lines.push('  verdict: MISSING BOT TOKEN');
        missing++;
        continue;
      }
      // sdk merge matches runtime: global sdk ⊕ per-bot FILE sdk (inline bots[]
      // entries carry no sdk block — only botToken/model/systemPrompt).
      const sources = detectAuthSources(mergeSdk(globalSdk, fileSdk), baseEnv, credentialsPath);
      // "(from global config)" is only true when the winning source is config-
      // based AND the bot carries no own sdk block — process.env / oauth-file
      // never come from the global config.
      const configBased = sources.some((s) => s.kind === 'config.apiKey' || s.kind === 'config.env');
      const originNote = configBased && !fileHasOwnSdk ? ' (from global config)' : '';
      lines.push(`  Claude auth: ${describeSources(sources)}${originNote}`);
      if (!hasUsableAuthSource(sources)) {
        lines.push('  verdict: UNKNOWN (no usable auth source)');
        missing++;
      } else {
        lines.push('  verdict: OK');
      }
    }
  }
  lines.push('');

  // --- Environment ---
  const env = baseEnv as DoctorEnv;
  const procCredential =
    env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN;
  lines.push('environment');
  // "(present in gateway env)" rather than "(inherited into the SDK
  // subprocess)": a declared sdk.env value may shadow this variable there (R7).
  lines.push(`  credential env (API_KEY/AUTH_TOKEN/OAUTH_TOKEN): ${procCredential ? `${maskKey(procCredential)} (present in gateway env)` : 'unset'}`);
  lines.push(`  ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL ? displayBaseUrl(env.ANTHROPIC_BASE_URL) : 'unset'}`);
  lines.push(`  ANTHROPIC_MODEL   : ${env.ANTHROPIC_MODEL ?? 'unset'}`);
  lines.push(`  OAuth login file  : ${credentialsPath} — ${existsSync(credentialsPath) ? 'present' : 'absent (macOS Keychain login is not statically detectable)'}`);
  lines.push('');

  // --- Verdict + guidance ---
  if (missing > 0) {
    lines.push(`verdict: ${missing} bot(s) without a statically detectable auth source. If you log in via the macOS Keychain, verify with \`claude auth status\` first. Otherwise fix with one of:`);
    lines.push('  - `npm run setup` (source) / `cc-channel-octo configure --from-claude` (global) — import the env block of ~/.claude/settings.json (token + base URL + model mapping); add `-- --bot <id>` / `--bot <id>` for a per-bot config');
    lines.push('  - `CC_OCTO_CONFIGURE_API_KEY=<key> cc-channel-octo configure --gateway-url <url>` (key stays out of argv/history)');
    lines.push('  - add sdk.apiKey or sdk.env to the bot\'s config.json (chmod 600)');
    lines.push('  - export ANTHROPIC_API_KEY in the shell that starts the gateway');
    lines.push('  - run `claude` + `/login` on this host (OAuth)');
  } else if (global.entries.length === 0) {
    lines.push('verdict: NO BOTS — configure bots before worrying about authentication');
  } else {
    lines.push('verdict: OK — every bot has a Claude authentication source');
  }
  return { text: lines.join('\n'), missing, hasBots: global.entries.length > 0 };
}

/**
 * Run doctor: print the report, return the process exit code. Env AND the OAuth
 * credentials path are injectable so tests never read ambient host state (a
 * developer machine with ANTHROPIC_API_KEY exported or a real
 * ~/.claude/.credentials.json must not flip the verdict).
 */
export function runDoctor(
  configPath?: string,
  baseEnv?: NodeJS.ProcessEnv,
  credentialsPath?: string,
): number {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  const report = doctorReport(
    path,
    baseEnv ?? process.env,
    credentialsPath ?? DEFAULT_CREDENTIALS_PATH,
  );
  console.log(report.text);
  // Exit code comes from the structured `missing` count — never from parsing
  // the report text (a healthy bot's per-bot "verdict: OK" would mask a broken
  // sibling under a substring check, inverting the contract for multi-bot).
  return report.missing > 0 ? 1 : 0;
}
