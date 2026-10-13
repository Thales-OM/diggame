'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// The server is CommonJS Node; the browser client is a plain script loaded by
// index.html, so it shares the Node globals for nothing and needs the browser
// ones instead (plus `io`, the socket.io client library from a script tag).
module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // an underscore marks a parameter that is part of the shape but not used
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, io: 'readonly' },
    },
  },
];
