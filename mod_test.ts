import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { filters } from "@steno/steno";
import type { SiteConfig } from "@steno/steno";
import createPlugin from "./mod.ts";

async function withTempSite(
  files: Record<string, string>,
): Promise<{ contentDir: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir();
  for (const [relPath, contents] of Object.entries(files)) {
    const fullPath = `${root}/${relPath}`;
    await Deno.mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(fullPath, contents);
  }
  return {
    contentDir: root,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

function baseConfig(contentDir: string): SiteConfig {
  return { title: "t", description: "d", author: "a", contentDir };
}

Deno.test("i18n: has a stable name", () => {
  const plugin = createPlugin();
  assertEquals(plugin.name, "i18n");
});

Deno.test("i18n: loads locale files into config.globals.i18n", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n",
    "i18n/es.yml": "nav:\n  blog: Blog en Español\n",
  });
  try {
    const plugin = createPlugin();
    const config = baseConfig(contentDir);
    await plugin.beforeBuild?.(config);
    assertEquals(
      (config.globals?.i18n as Record<string, unknown>)?.en,
      { nav: { blog: "Blog" } },
    );
    assertEquals(
      (config.globals?.i18n as Record<string, unknown>)?.es,
      { nav: { blog: "Blog en Español" } },
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() resolves a dot-path key for the requested locale", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n",
    "i18n/es.yml": "nav:\n  blog: Bitácora\n",
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.t("nav.blog", "es"), "Bitácora");
    assertEquals(filters.t("nav.blog", "en"), "Blog");
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() falls back to the default locale when the key is missing", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n  support: Support\n",
    "i18n/es.yml": "nav:\n  blog: Bitácora\n",
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.t("nav.support", "es"), "Support");
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() falls back to an explicit fallback argument", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n",
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(
      filters.t("nav.missing", "en", "Fallback text"),
      "Fallback text",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() falls back to the raw key when nothing else resolves", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n",
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.t("nav.missing", "en"), "nav.missing");
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: strict mode throws instead of falling back to the key", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n",
  });
  try {
    const plugin = createPlugin({ strict: true });
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertThrows(
      () => filters.t("nav.missing", "en"),
      Error,
      "i18n-missing-key",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: missing locale directory yields an empty dictionary, not an error", async () => {
  const { contentDir, cleanup } = await withTempSite({ "index.md": "# hi" });
  try {
    const plugin = createPlugin();
    const config = baseConfig(contentDir);
    await plugin.beforeBuild?.(config);
    assertEquals(config.globals?.i18n, {});
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: an invalid locale file rejects beforeBuild with a clear message", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav: [unterminated\n",
  });
  try {
    const plugin = createPlugin();
    await assertRejects(
      () => Promise.resolve(plugin.beforeBuild?.(baseConfig(contentDir))),
      Error,
      "i18n-file-invalid",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() interpolates MF2 variables", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "greeting: Hello, {$name}!\n",
  });
  try {
    const plugin = createPlugin({ bidiIsolation: "none" });
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(
      filters.t("greeting", "en", undefined, { name: "Ada" }),
      "Hello, Ada!",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() accepts vars as the third argument when no fallback is given", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "greeting: Hello, {$name}!\n",
  });
  try {
    const plugin = createPlugin({ bidiIsolation: "none" });
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.t("greeting", "en", { name: "Ada" }), "Hello, Ada!");
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() wraps interpolated values in bidi isolate marks by default", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "greeting: Hello, {$name}!\n",
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(
      filters.t("greeting", "en", undefined, { name: "Ada" }),
      "Hello, ⁨Ada⁩!",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() resolves MF2 plural selectors", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": [
      "notif: |",
      "  .input {$count :number}",
      "  .match $count",
      "  one {{You have {$count} notification.}}",
      "  *   {{You have {$count} notifications.}}",
      "",
    ].join("\n"),
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(
      filters.t("notif", "en", undefined, { count: 1 }),
      "You have 1 notification.",
    );
    assertEquals(
      filters.t("notif", "en", undefined, { count: 5 }),
      "You have 5 notifications.",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: t() falls back when the message is not valid MF2 syntax", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "broken: |\n  .match $x\n  one {{x}}\n",
  });
  try {
    const plugin = createPlugin();
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.t("broken", "en", "Fallback text"), "Fallback text");
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: strict mode throws on invalid MF2 syntax", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "broken: |\n  .match $x\n  one {{x}}\n",
  });
  try {
    const plugin = createPlugin({ strict: true });
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertThrows(
      () => filters.t("broken", "en"),
      Error,
      "i18n-invalid-message",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("i18n: custom dir and filterName options are respected", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "locales/en.yml": "greeting: Hi\n",
  });
  try {
    const plugin = createPlugin({ dir: "locales", filterName: "translate" });
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.translate("greeting", "en"), "Hi");
  } finally {
    await cleanup();
  }
});
