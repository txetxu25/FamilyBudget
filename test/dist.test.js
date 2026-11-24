// dist/ se sube a Apps Script tal cual: debe coincidir con lo que genera el build desde src/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('dist/ está al día con src/ (ejecuta npm run build)', () => {
  const expected = require('../scripts/build.js'); // regenera dist/ en memoria y en disco
  for (const [name, content] of Object.entries(expected)) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', 'dist', name), 'utf8'), content, name);
  }
});

test('el cliente no usa funciones de servidor inexistentes', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const called = [...app.matchAll(/api\('(\w+)'/g)].map((m) => m[1]);
  assert.ok(called.length > 5);
  for (const fn of new Set(called)) assert.match(server, new RegExp('function ' + fn + '\\('), fn);
});
