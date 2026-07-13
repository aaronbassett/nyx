// Flat config: strict type-aware linting per DS-001. Workspaces extend this root config.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "pocs/**", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // Root config files (this file, commitlint.config.mjs) aren't part of any
    // tsconfig, so the type-aware project service can't resolve them. Lint them
    // without type information instead of erroring.
    files: ["**/*.config.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
