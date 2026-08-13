# @steno/plugin-i18n

Locale dictionary loading and a `t()` lookup filter for [Steno](https://github.com/stenopress/steno)
sites. Drop translation files in `content/i18n/`, call `t()` in templates, done — no manual
`{#let d = data.i18n[lang] ?? data.i18n.en}` boilerplate, no per-page fallback logic to write
yourself, and no `.format()` calls to wire up for plurals or variables.

## Install

```yaml
# config.yml
plugins:
  - package: jsr:@steno/plugin-i18n
    options:
      defaultLocale: en
```

**Must run trusted** (the default `mode`). This plugin registers `t` on Steno's shared template
filter map, which only exists inside Steno's own process — `mode: isolated` runs a plugin in a
sandboxed subprocess with no access to that map, so setting it here would silently leave `t`
undefined at render time. Don't add `mode: isolated` to this entry.

## 1. Add locale files

One file per locale, in `content/i18n/` by default (`dir` option changes the folder). The
filename — without extension — is the locale code. Nest keys however deep makes sense; `t()`
walks the nesting with dot-paths.

```yaml
# content/i18n/en.yml
nav:
  blog: Blog
  support: Support
home:
  title: Welcome
  cta: Get started
```

```yaml
# content/i18n/es.yml
nav:
  blog: Bitácora
  support: Soporte
home:
  title: Bienvenido
  # cta is intentionally missing — see fallback behavior below
```

`.yml`, `.yaml`, `.json`, and `.toml` are all supported, mixed freely — `content/i18n/pt-BR.json`
gives you locale `"pt-BR"` just as well as a `.yml` file would.

## 2. Know where `lang` comes from

This plugin resolves a key **for a locale you give it** — it does not decide which locale a page
is. That's ordinary Steno frontmatter, same as before:

```yaml
# content/index.es.md
---
layout: home
lang: es
permalink: /es/
---
```

`lang` then lands in the template context automatically, and you pass it straight into `t()`.

## 3. Call `t()` in templates

No `{#let}`, no manual `??`, no per-file "does this locale have the key" check — one call:

```html
<a href="/blog/">{ "nav.blog" | t(lang) }</a>
<h1>{ "home.title" | t(lang) }</h1>
```

That's the whole pattern. Compare to what it replaces:

```html
<!-- before, hand-rolled per layout -->
{#let d = data.i18n[lang] ?? data.i18n.en}
<h1>{d.home.title}</h1>

<!-- after -->
<h1>{ "home.title" | t(lang) }</h1>
```

The old style falls back **per whole file**: if `es.yml` is missing entirely, you get all of
`en.yml`. `t()` falls back **per key**: an `es.yml` that has 90% of the keys still serves those
90% in Spanish, and only the missing 10% quietly borrows English. Partial translations stop being
an all-or-nothing gamble.

### Lookup order

For `{ "nav.blog" | t(lang) }`:

1. `nav.blog` in the locale named by `lang`.
2. `nav.blog` in `defaultLocale` (`en` unless you changed it), if step 1 came up empty.
3. A fallback argument, if you gave one: `{ "nav.blog" | t(lang, "Blog") }`.
4. The raw key string itself (`"nav.blog"`) — a typo'd or not-yet-translated key renders as
   visible-but-ugly text instead of breaking the page.

Every key that falls through to step 4 gets logged once, batched, at the end of the build:

```
[i18n-missing-key] 2 translation(s) fell back to their key:
  - "home.cta" (locale "es")
  - "footer.legal" (locale "it")
```

The build still succeeds — this is a warning, not a failure. Use it as a translation-coverage
checklist, not a gate. Set `strict: true` to throw immediately on the first unresolved key
instead (e.g. in CI, before a release).

### A key that isn't a plain value

If a key resolves to a nested object instead of a string — you asked for `"nav"` instead of
`"nav.blog"`, say — `t()` treats that as "not found" too and continues down the fallback chain.
It will not stringify an object into `[object Object]` on you.

## Variables, plurals, and gender (MessageFormat 2)

Every resolved value is formatted as a [MessageFormat 2](https://messageformat.unicode.org/) (MF2)
message before it's returned. A plain string like `"Blog"` is a valid, trivial MF2 message and
passes through untouched — you don't opt into any of this, and existing plain-text locale files
need no changes. But once a value needs a variable, a plural form, or a gendered/selected phrase,
write MF2 syntax and pass a `vars` object as `t()`'s last argument:

```yaml
# content/i18n/en.yml
greeting: Hello, {$name}!

notif: |
  .input {$count :number}
  .match $count
  one {{You have {$count} notification.}}
  *   {{You have {$count} notifications.}}
```

```html
<p>{ "greeting" | t(lang, undefined, {name: user.name}) }</p>
<p>{ "notif" | t(lang, undefined, {count: unreadCount}) }</p>
```

`t(key, locale, fallback?, vars?)` — pass `undefined` for `fallback` to skip straight to `vars` as
above, or use the 3-argument form `t(key, locale, {count: 5})` when you don't need a custom
fallback at all (a plain object as the third argument is always read as `vars`, never as a
fallback string).

MF2 covers pluralization (`.match` on a `:number`), gender/selection (`.match` on a `:string`),
locale-aware number and date formatting (`{$price :number}`, `{$date :datetime}`), and more — see
the [MF2 quick-start guide](https://messageformat.unicode.org/docs/quick-start/) for the full
syntax. Each locale's plural/selection rules apply automatically from the `locale` argument you
pass to `t()`, so `.match $count` picks `one`/`few`/`many`/`other` correctly per language without
you writing that logic.

### Bidi isolation

By default, every interpolated value is wrapped in invisible Unicode isolate marks
(`U+2066`…`U+2069`) — MF2's own protection against a variable's text (e.g. right-to-left or
mixed-script content) visually corrupting the direction of the surrounding message. These marks
are invisible in rendered HTML; there's normally no reason to touch this. Set
`bidiIsolation: "none"` if you specifically need raw output without them.

### Invalid MF2 syntax

A locale value that isn't valid MF2 (a typo in `.match`, an unbalanced `{}`, etc.) doesn't fail
the build by default — `t()` falls back to the `fallback` argument or the raw key, same as a
missing key, and the problem is batched into a separate warning:

```
[i18n-invalid-message] 1 translation(s) had invalid MessageFormat 2 syntax or a formatting error:
  - "notif" (locale "es")
```

This also covers format-time problems, like a `vars` object missing a variable the message
references. Set `strict: true` to throw immediately instead.

## Options

| Option          | Default   | Description                                                                |
| --------------- | --------- | ---------------------------------------------------------------------------- |
| `dir`           | `i18n`    | Locale-files directory, relative to `contentDir`.                            |
| `defaultLocale` | `en`      | Locale used when a key is missing from the requested locale.                 |
| `filterName`    | `t`       | Name of the registered filter — rename if it collides with another one.      |
| `strict`        | `false`   | Throw immediately on an unresolved key or invalid MF2 message, instead of falling back. |
| `bidiIsolation` | `default` | Set to `"none"` to disable MF2's bidi-isolate wrapping around interpolated values. |

## Raw dictionary access

The whole loaded dictionary is also exposed as `globals.i18n`, keyed by locale — for the rare case
`t()` doesn't cover, like listing every language a site has, or building a language switcher:

```html
{#each ["en", "es", "it"] as code}
<a href="{ code == lang ? '#' : '/' + code + '/' }">{ code | upper }</a>
{/each}
```

You generally won't need this — reach for `t()` first.

## Notes

- **Locale files reload on every `steno dev` rebuild.** `beforeBuild` runs every build regardless
  of Steno's plugin-factory caching, so editing a locale file and saving is enough — no dev
  server restart needed.
- **One filter name across the whole build.** If two plugins both register a filter called `t`,
  the second one silently wins. Set `filterName` on one of them if that's a real collision, not a
  hypothetical one.
- **A locale file that fails to parse fails the build**, reported as `[i18n-file-invalid]` with
  the file path and the underlying parse error — same treatment as Steno's own
  `[data-file-invalid]` for `_data/` files.
- **A missing `content/i18n/` directory is not an error.** You get an empty dictionary and every
  `t()` call falls back to its key (or `defaultLocale`/fallback argument), so you can add
  translations gradually.

## Test

```sh
deno task test
```
