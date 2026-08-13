/**
 * @steno/plugin-i18n - loads per-locale dictionaries from a directory and
 * exposes a `t()` template filter that looks up a key for the current
 * locale, falls back to a default locale, then to an explicit fallback
 * value, then to the key itself. Resolved strings are formatted as
 * MessageFormat 2 (MF2) messages, so interpolation and plurals work
 * without any extra wiring.
 *
 * @module
 */

import { join, parse as parsePath } from "@std/path";
import { parse as parseToml } from "@std/toml";
import { parse as parseYaml } from "@std/yaml";
import { MessageFormat } from "messageformat";
import { filters } from "@steno/steno";
import type { SiteConfig, StenoPlugin } from "@steno/steno";

/** Options accepted by this plugin. */
export interface I18nOptions {
  /**
   * Directory holding one file per locale (`en.yml`, `es.yml`, ...),
   * relative to `contentDir`. Defaults to `"i18n"`.
   */
  dir?: string;
  /**
   * Locale used when a key is missing from the requested locale.
   * Defaults to `"en"`.
   */
  defaultLocale?: string;
  /**
   * Name of the registered Tau filter. Defaults to `"t"`. Change this if
   * it collides with a filter another plugin already registered.
   */
  filterName?: string;
  /**
   * When true, a key missing from both the requested and default locale
   * (and with no explicit fallback argument) throws instead of falling
   * back to the raw key. Defaults to `false`.
   */
  strict?: boolean;
  /**
   * Passed straight through to MessageFormat 2's `bidiIsolation`. Defaults
   * to `"default"`, which wraps each interpolated value in invisible
   * Unicode isolate marks (U+2066/U+2069) so a variable holding
   * right-to-left or mixed-script text can't visually corrupt the
   * surrounding message — invisible in rendered HTML, harmless to leave
   * on. Set to `"none"` to turn it off.
   */
  bidiIsolation?: "default" | "none";
}

/** A parsed locale dictionary, keyed by locale code, holding nested objects. */
export type LocaleDict = Record<string, Record<string, unknown>>;

const SUPPORTED_EXT: Record<string, (text: string) => unknown> = {
  ".yml": (text) => parseYaml(text),
  ".yaml": (text) => parseYaml(text),
  ".json": (text) => JSON.parse(text),
  ".toml": (text) => parseToml(text),
};

async function loadLocaleDict(dirPath: string): Promise<LocaleDict> {
  const dict: LocaleDict = {};

  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dirPath)];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return dict;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isFile) continue;
    const { name, ext } = parsePath(entry.name);
    const parse = SUPPORTED_EXT[ext.toLowerCase()];
    if (!parse) continue;

    const filePath = join(dirPath, entry.name);
    const text = await Deno.readTextFile(filePath);
    let parsed: unknown;
    try {
      parsed = parse(text);
    } catch (err) {
      throw new Error(
        `[i18n-file-invalid] Failed to parse locale file "${filePath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    dict[name] = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
      string,
      unknown
    >;
  }

  return dict;
}

function lookup(
  source: Record<string, unknown> | undefined,
  path: string[],
): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Creates the i18n plugin.
 *
 * Registered in a site's config.yml:
 *
 * ```yaml
 * plugins:
 *   - package: jsr:@steno/plugin-i18n
 * ```
 *
 * Drop one file per locale in `content/i18n/` (`en.yml`, `es.yml`, ...),
 * each a nested map of keys to strings:
 *
 * ```yaml
 * # content/i18n/en.yml
 * nav:
 *   blog: Blog
 *   support: Support
 * ```
 *
 * Every resolved value is run through MessageFormat 2 (MF2), so plain
 * strings pass through untouched and interpolation, plurals, and select
 * (gender/etc.) all work without any extra wiring:
 *
 * ```yaml
 * # content/i18n/en.yml
 * nav:
 *   blog: Blog
 * notif: |
 *   .input {$count :number}
 *   .match $count
 *   one {{You have {$count} notification.}}
 *   *   {{You have {$count} notifications.}}
 * ```
 *
 * Then in a template:
 *
 * ```html
 * <a href="/blog/">{ "nav.blog" | t(lang) }</a>
 * <a href="/blog/">{ "nav.blog" | t(lang, "Blog") }</a>
 * <p>{ "notif" | t(lang, undefined, {count: unreadCount}) }</p>
 * ```
 *
 * `t(key, locale, fallback?, vars?)` — `fallback` and `vars` are both
 * optional; if the third argument is an object it's treated as `vars`
 * with no custom fallback (`t(key, locale, {count: 5})` works too).
 *
 * This plugin registers a filter on the shared Tau filter map, which only
 * exists in Steno's own process. It therefore only works as a `trusted`
 * plugin — `mode: isolated` runs it in a subprocess with no access to
 * that map, and the `t` filter would never appear.
 */
export default function i18n(options: I18nOptions = {}): StenoPlugin {
  const dirName = options.dir ?? "i18n";
  const defaultLocale = options.defaultLocale ?? "en";
  const filterName = options.filterName ?? "t";
  const strict = options.strict ?? false;
  const bidiIsolation = options.bidiIsolation ?? "default";

  let dict: LocaleDict = {};
  let missingKeys: Set<string> = new Set();
  let invalidMessages: Set<string> = new Set();
  // Keyed by "locale source" so identical text in different locales
  // compiles (and fails) independently. `null` caches a parse failure so a
  // broken message isn't re-parsed, and re-warned about, on every call.
  let compiled: Map<string, MessageFormat | null> = new Map();

  function compile(locale: string, source: string): MessageFormat | null {
    const cacheKey = `${locale} ${source}`;
    if (compiled.has(cacheKey)) return compiled.get(cacheKey)!;
    let mf: MessageFormat | null;
    try {
      mf = new MessageFormat(locale, source, { bidiIsolation });
    } catch {
      mf = null;
    }
    compiled.set(cacheKey, mf);
    return mf;
  }

  return {
    name: "i18n",

    async beforeBuild(config: SiteConfig) {
      const contentDir = config.contentDir ?? "content";
      dict = await loadLocaleDict(join(contentDir, dirName));
      missingKeys = new Set();
      invalidMessages = new Set();
      compiled = new Map();

      config.globals = { ...config.globals, i18n: dict };

      filters[filterName] = (
        key: unknown,
        locale?: unknown,
        arg3?: unknown,
        arg4?: unknown,
      ) => {
        if (typeof key !== "string" || key === "") return "";
        const path = key.split(".");
        const requestedLocale = typeof locale === "string" && locale
          ? locale
          : defaultLocale;

        const isVars = (v: unknown): v is Record<string, unknown> =>
          typeof v === "object" && v !== null;
        const fallback = isVars(arg3)
          ? undefined
          : (arg3 as string | undefined);
        const vars = isVars(arg3) ? arg3 : (isVars(arg4) ? arg4 : undefined);

        let value = lookup(dict[requestedLocale], path);
        if (value === undefined && requestedLocale !== defaultLocale) {
          value = lookup(dict[defaultLocale], path);
        }

        if (value === undefined || typeof value === "object") {
          if (fallback !== undefined) return String(fallback);
          missingKeys.add(`${requestedLocale}:${key}`);
          if (strict) {
            throw new Error(
              `[i18n-missing-key] No translation for "${key}" in locale "${requestedLocale}" ` +
                `(default locale "${defaultLocale}") and no fallback argument given.`,
            );
          }
          return key;
        }

        const mf = compile(requestedLocale, String(value));
        if (!mf) {
          invalidMessages.add(`${requestedLocale}:${key}`);
          if (strict) {
            throw new Error(
              `[i18n-invalid-message] "${key}" in locale "${requestedLocale}" is not valid ` +
                `MessageFormat 2 syntax.`,
            );
          }
          return fallback !== undefined ? String(fallback) : key;
        }

        let hadFormatError = false;
        const formatted = mf.format(vars ?? {}, () => {
          hadFormatError = true;
        });
        if (hadFormatError) {
          invalidMessages.add(`${requestedLocale}:${key}`);
          if (strict) {
            throw new Error(
              `[i18n-invalid-message] "${key}" in locale "${requestedLocale}" failed to format ` +
                `(missing or mistyped variable?).`,
            );
          }
        }
        return formatted;
      };
    },

    afterBuild() {
      if (missingKeys.size > 0) {
        console.warn(
          `[i18n-missing-key] ${missingKeys.size} translation(s) fell back to their key:`,
        );
        for (const miss of [...missingKeys].sort()) {
          const [locale, key] = miss.split(/:(.+)/);
          console.warn(`  - "${key}" (locale "${locale}")`);
        }
      }
      if (invalidMessages.size > 0) {
        console.warn(
          `[i18n-invalid-message] ${invalidMessages.size} translation(s) had invalid ` +
            `MessageFormat 2 syntax or a formatting error:`,
        );
        for (const miss of [...invalidMessages].sort()) {
          const [locale, key] = miss.split(/:(.+)/);
          console.warn(`  - "${key}" (locale "${locale}")`);
        }
      }
    },
  };
}
