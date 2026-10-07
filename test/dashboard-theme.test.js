import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getThemeMode,
  setThemeMode,
  syncHanaTheme,
  toggleTheme,
  THEME_STORAGE_KEY,
} from '../ui/modules/theme.js';

test('theme module reads default and updates localStorage correctly', () => {
  const store = {};
  globalThis.localStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
  };

  assert.equal(getThemeMode(), 'auto');
  setThemeMode('dark');
  assert.equal(getThemeMode(), 'dark');
  assert.equal(store[THEME_STORAGE_KEY], 'dark');
});

test('syncHanaTheme maps explicit mode and host attribute to body data-theme', () => {
  const store = {};
  const attrs = {};
  const body = {
    getAttribute: k => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = String(v); },
  };
  globalThis.document = {
    body,
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
  };

  // mode = dark
  setThemeMode('dark');
  const resDark = syncHanaTheme();
  assert.equal(resDark.theme, 'dark');
  assert.equal(attrs['data-theme'], 'dark');

  // mode = auto with midnight host theme
  setThemeMode('auto');
  attrs['data-hana-theme'] = 'midnight';
  const resMidnight = syncHanaTheme();
  assert.equal(resMidnight.theme, 'dark');
  assert.equal(attrs['data-theme'], 'dark');

  // toggleTheme flips theme
  toggleTheme();
  assert.equal(attrs['data-theme'], 'light');
});
