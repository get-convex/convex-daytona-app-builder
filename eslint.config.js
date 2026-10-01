import js from '@eslint/js'
import convexPlugin from '@convex-dev/eslint-plugin'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
  { ignores: ['dist', 'convex/_generated'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: globals.browser } },
  ...convexPlugin.configs.recommended,
])
