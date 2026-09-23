// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Not app code: Claude skill examples (their own deps), the Deno edge functions (checked with
    // `deno task check`, not eslint), site/graph outputs. 2026-09-22: these were 24 of the 58 "errors".
    ignores: ['dist/*', '.claude/**', 'supabase/**', '.netlify/**', 'graphify-out/**', 'hairpin-site/**', '.ds-sync/**'],
  },
  {
    // CommonJS gate scripts under tools/ run under plain node.
    files: ['**/*.cjs'],
    languageOptions: { globals: { __dirname: 'readonly', require: 'readonly', module: 'writable', process: 'readonly' } },
  },
  {
    // Apostrophes in JSX copy ("you're", "we'll") are not a defect; eslint-config-expo's rule flagged
    // 31 of them as ERRORS and hid the real ones. Off, like most RN projects.
    rules: { 'react/no-unescaped-entities': 'off' },
  },
]);
