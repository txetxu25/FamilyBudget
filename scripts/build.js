// Genera dist/: lo que se pega en Apps Script. Solo 3 piezas para que la instalación sea simple:
//   Code.js         = núcleo (src/core.js) + servidor (src/server.js)
//   Index.html      = interfaz con estilos, núcleo y app incrustados
//   appsscript.json = manifiesto
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
const banner = '// GENERADO por scripts/build.js desde src/. No editar a mano.\n';
const core = src('core.js');
const parts = {
  Styles: src('Styles.html'),
  CoreClient: '<script>\n' + core.replace(/<\/script/gi, '<\\/script') + '\n</script>\n',
  App: src('App.html')
};
const index = src('Index.html').replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => {
  if (!parts[n]) throw new Error('include desconocido: ' + n);
  return parts[n];
});
if (/<\?/.test(index)) throw new Error('Index.html incrustado aún contiene "<?": Apps Script lo interpretaría');
const files = {
  'Code.js': banner + core + '\n\n// ===================================================== servidor\n\n' + src('server.js'),
  'Index.html': '<!-- GENERADO por scripts/build.js desde src/. No editar a mano. -->\n' + index,
  'appsscript.json': src('appsscript.json')
};
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dist, name), content);
if (require.main === module) console.log('dist/ generado:', Object.keys(files).join(', '));
module.exports = files;
