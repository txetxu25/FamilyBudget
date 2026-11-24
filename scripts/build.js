// Genera dist/ (lo que se sube a Apps Script) a partir de src/.
// El núcleo se usa dos veces: como .gs en el servidor y como <script> en el cliente.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
const banner = '// GENERADO por scripts/build.js desde src/. No editar a mano.\n';
const core = src('core.js');
const files = {
  'Core.js': banner + core,
  'Code.js': banner + src('server.js'),
  'CoreClient.html': '<script>\n' + core.replace(/<\/script/gi, '<\\/script') + '\n</script>\n',
  'Index.html': src('Index.html'),
  'Styles.html': src('Styles.html'),
  'App.html': src('App.html'),
  'appsscript.json': src('appsscript.json')
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), content);
if (require.main === module) console.log('dist/ generado:', Object.keys(files).join(', '));
module.exports = files;
