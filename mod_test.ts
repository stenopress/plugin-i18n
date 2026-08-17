import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
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
    assertEquals((config.globals?.i18n as Record<string, unknown>)?.en, {
      nav: { blog: "Blog" },
    });
    assertEquals((config.globals?.i18n as Record<string, unknown>)?.es, {
      nav: { blog: "Blog en Español" },
    });
  } finally {
    await cleanup();
  }
});

Deno.test(
  "i18n: t() resolves a dot-path key for the requested locale",
  async () => {
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
  },
);

Deno.test(
  "i18n: t() falls back to the default locale when the key is missing",
  async () => {
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
  },
);

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

Deno.test(
  "i18n: t() falls back to the raw key when nothing else resolves",
  async () => {
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
  },
);

Deno.test(
  "i18n: strict mode throws instead of falling back to the key",
  async () => {
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
  },
);

Deno.test(
  "i18n: missing locale directory yields an empty dictionary, not an error",
  async () => {
    const { contentDir, cleanup } = await withTempSite({ "index.md": "# hi" });
    try {
      const plugin = createPlugin();
      const config = baseConfig(contentDir);
      await plugin.beforeBuild?.(config);
      assertEquals(config.globals?.i18n, {});
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: an invalid locale file rejects beforeBuild with a clear message",
  async () => {
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
  },
);

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

Deno.test(
  "i18n: t() accepts vars as the third argument when no fallback is given",
  async () => {
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
  },
);

Deno.test(
  "i18n: t() wraps interpolated values in bidi isolate marks by default",
  async () => {
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
  },
);

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

Deno.test(
  "i18n: t() falls back when the message is not valid MF2 syntax",
  async () => {
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
  },
);

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

Deno.test(
  "i18n: loads .json and .toml locale files alongside .yml",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
      "i18n/fr.json": JSON.stringify({ nav: { blog: "Le Blog" } }),
      "i18n/de.toml": 'nav.blog = "Der Blog"\n',
    });
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("nav.blog", "fr"), "Le Blog");
      assertEquals(filters.t("nav.blog", "de"), "Der Blog");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: ignores files with unsupported extensions in the locale dir",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
      "i18n/README.md": "# not a locale file\n",
      "i18n/.DS_Store": "junk",
    });
    try {
      const plugin = createPlugin();
      const config = baseConfig(contentDir);
      await plugin.beforeBuild?.(config);
      assertEquals(
        Object.keys(config.globals?.i18n as Record<string, unknown>),
        ["en"],
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: a locale file that parses to a scalar becomes an empty dictionary",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "just a plain string\n",
    });
    try {
      const plugin = createPlugin();
      const config = baseConfig(contentDir);
      await plugin.beforeBuild?.(config);
      assertEquals((config.globals?.i18n as Record<string, unknown>)?.en, {});
      assertEquals(filters.t("nav.blog", "en"), "nav.blog");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: t() defaults to the default locale when no locale argument is given",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("nav.blog"), "Blog");
    } finally {
      await cleanup();
    }
  },
);

Deno.test("i18n: t() uses a custom defaultLocale for fallback", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/fr.yml": "nav:\n  blog: Le Blog\n  support: Support FR\n",
    "i18n/es.yml": "nav:\n  blog: Bitácora\n",
  });
  try {
    const plugin = createPlugin({ defaultLocale: "fr" });
    await plugin.beforeBuild?.(baseConfig(contentDir));
    assertEquals(filters.t("nav.support", "es"), "Support FR");
  } finally {
    await cleanup();
  }
});

Deno.test(
  "i18n: t() returns an empty string for a non-string or empty key",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t(""), "");
      // deno-lint-ignore no-explicit-any
      assertEquals(filters.t(42 as any), "");
      // deno-lint-ignore no-explicit-any
      assertEquals(filters.t(undefined as any), "");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: t() treats an intermediate object key as missing, not a crash",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("nav"), "nav");
      assertEquals(filters.t("nav.blog.title"), "nav.blog.title");
    } finally {
      await cleanup();
    }
  },
);

Deno.test("i18n: preserves pre-existing config.globals entries", async () => {
  const { contentDir, cleanup } = await withTempSite({
    "i18n/en.yml": "nav:\n  blog: Blog\n",
  });
  try {
    const plugin = createPlugin();
    const config = baseConfig(contentDir);
    config.globals = { site: "mine" };
    await plugin.beforeBuild?.(config);
    assertEquals(config.globals?.site, "mine");
    assertEquals((config.globals?.i18n as Record<string, unknown>)?.en, {
      nav: { blog: "Blog" },
    });
  } finally {
    await cleanup();
  }
});

Deno.test(
  "i18n: a missing var is a non-fatal format error — the unresolved placeholder is still returned",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "greeting: Hello, {$name}!\n",
    });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const plugin = createPlugin({ bidiIsolation: "none" });
      await plugin.beforeBuild?.(baseConfig(contentDir));
      // No `vars` given even though the message references {$name}: not a
      // parse-time error, so it doesn't fall back to `fallback`/the key —
      // it renders with the variable left unresolved, and gets logged.
      assertEquals(filters.t("greeting", "en", "Hi there"), "Hello, {$name}!");
      plugin.afterBuild?.(baseConfig(contentDir));
      assert(
        warnings.some(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("i18n-invalid-message"),
        ),
      );
    } finally {
      console.warn = originalWarn;
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: strict mode throws when vars are missing for an interpolated message",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "greeting: Hello, {$name}!\n",
    });
    try {
      const plugin = createPlugin({ strict: true, bidiIsolation: "none" });
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertThrows(
        () => filters.t("greeting", "en"),
        Error,
        "i18n-invalid-message",
      );
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: afterBuild logs a batched warning for missing keys",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      filters.t("nav.missing", "en");
      plugin.afterBuild?.(baseConfig(contentDir));
      assert(
        warnings.some(
          (args) =>
            typeof args[0] === "string" && args[0].includes("i18n-missing-key"),
        ),
      );
    } finally {
      console.warn = originalWarn;
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: afterBuild logs a batched warning for invalid MF2 messages",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "broken: |\n  .match $x\n  one {{x}}\n",
    });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      filters.t("broken", "en");
      plugin.afterBuild?.(baseConfig(contentDir));
      assert(
        warnings.some(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("i18n-invalid-message"),
        ),
      );
    } finally {
      console.warn = originalWarn;
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: afterBuild logs nothing when there are no missing keys or invalid messages",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    const originalWarn = console.warn;
    let called = false;
    console.warn = () => {
      called = true;
    };
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      filters.t("nav.blog", "en");
      plugin.afterBuild?.(baseConfig(contentDir));
      assertEquals(called, false);
    } finally {
      console.warn = originalWarn;
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: beforeBuild reloads the dictionary on every call (dev rebuild)",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("nav.blog", "en"), "Blog");

      await Deno.writeTextFile(
        `${contentDir}/i18n/en.yml`,
        "nav:\n  blog: Updated Blog\n",
      );
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("nav.blog", "en"), "Updated Blog");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: beforeBuild clears missing-key and invalid-message state between builds",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "nav:\n  blog: Blog\n",
    });
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      filters.t("nav.missing", "en");

      // Second build with no lookups performed: the stale missing-key record
      // from the previous build must not resurface in this build's warnings.
      await plugin.beforeBuild?.(baseConfig(contentDir));
      plugin.afterBuild?.(baseConfig(contentDir));
      assertEquals(warnings.length, 0);
    } finally {
      console.warn = originalWarn;
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: a numeric locale value is coerced to a string and formatted as MF2",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "version: 42\n",
    });
    try {
      const plugin = createPlugin();
      await plugin.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("version", "en"), "42");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "i18n: two plugin instances with distinct filterNames don't clobber each other",
  async () => {
    const { contentDir, cleanup } = await withTempSite({
      "i18n/en.yml": "greeting: Hi\n",
      "other/en.yml": "greeting: Yo\n",
    });
    try {
      const pluginA = createPlugin({ filterName: "t" });
      const pluginB = createPlugin({ dir: "other", filterName: "t2" });
      await pluginA.beforeBuild?.(baseConfig(contentDir));
      await pluginB.beforeBuild?.(baseConfig(contentDir));
      assertEquals(filters.t("greeting", "en"), "Hi");
      assertEquals(filters.t2("greeting", "en"), "Yo");
    } finally {
      await cleanup();
    }
  },
);
