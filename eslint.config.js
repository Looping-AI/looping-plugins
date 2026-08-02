import tseslint from "typescript-eslint";
import looping from "@loopingai/core/eslint";

const LINTED_FILES = ["src/**/*.ts", "test/**/*.ts"];

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: LINTED_FILES,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              // The one thing a plugin genuinely cannot share with core. The
              // migrator keeps a single flat integer journal and one global
              // `__drizzle_migrations` table, so two independently-versioned
              // packages collide in it — the two predecessor agents had already
              // forked that journal at index 1. Drizzle's *query builder* is
              // fine and is what plugins should use; only this import is banned.
              name: "drizzle-orm/durable-sqlite/migrator",
              message:
                "A plugin must not run drizzle's migrator — it shares one journal with core. " +
                "Declare a PluginStore with idempotent CREATE TABLE IF NOT EXISTS DDL instead, " +
                "and keep using drizzle for queries."
            }
          ]
        }
      ]
    }
  },
  {
    // Type-aware pass — enables @deprecated detection without switching the
    // whole config to recommendedTypeChecked and its stricter rule set.
    files: LINTED_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin, looping },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      "looping/no-deprecated-object-properties": "error"
    }
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      ".wrangler/",
      "worker-configuration.d.ts"
    ]
  }
);
