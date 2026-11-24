// Vista previa local sin Apps Script: monta Index.html con una API simulada en memoria.
// Uso: node scripts/preview.js [datos.json] [salida.html]
//   datos.json opcional: { partidas, presupuesto, reglas, movimientos, ... }. Si no se da, usa datos de demo sintéticos.
const fs = require('fs');
const path = require('path');
const files = require('./build.js');
const dataPath = process.argv[2];
const out = process.argv[3] || path.join(__dirname, '..', 'dev', 'preview.html');
const data = dataPath ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : require('../dev/demo-data.js')();
let html = files['Index.html'].replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => {
  if (n === 'CoreClient') return files['CoreClient.html'];
  return files[n + '.html'];
});
const mock = `<script>
window.__DATA__ = ${JSON.stringify(Object.assign({ usuario: 'demo@example.com', archivos: [], hojaUrl: 'https://docs.google.com/spreadsheets/d/demo', config: { carpetaExtractos: '', anioActivo: '2026', usuarios: '', umbralAmbar: '0.15', umbralRojo: '0.3', minimoDesviacion: '50', excelCopia: '', excelAuto: 'no' } }, data))};
window.__MOCK_API__ = function (fn, args) {
  var D = window.__DATA__;
  var reclass = function () { var c = FB.classifyAll(D.movimientos, D.reglas, D.partidas); D.movimientos = c.movimientos; return c; };
  var r = {
    apiBootstrap: function () { return JSON.parse(JSON.stringify(D)); },
    apiAcceptSuggestions: function (ids) { D.movimientos.forEach(function (m) { if (ids.indexOf(m.id) >= 0) { m.tipologia = m.tipologia || m.sugerencia; m.estado = 'manual'; } }); var c = reclass(); return { movimientos: c.movimientos, stats: c.stats }; },
    apiClassify: function (ids, t, o) { D.movimientos.forEach(function (m) { if (ids.indexOf(m.id) >= 0) { m.tipologia = t; m.estado = t ? 'manual' : 'pendiente'; m.nota = o.nota; } }); if (o.regla && o.regla.patron) D.reglas.push(Object.assign({ id: 'n' + Date.now(), tipologia: t }, o.regla)); var c = reclass(); return { movimientos: c.movimientos, reglas: D.reglas, stats: c.stats }; },
    apiSaveBudget: function (y, cells) { D.presupuesto = D.presupuesto.filter(function (b) { return b.anio != y; }).concat(cells.map(function (c) { return { anio: y, mes: c.mes, tipologia: c.tipologia, importe: c.importe }; })); return D.presupuesto; },
    apiSaveRules: function (rules) { D.reglas = rules; var c = reclass(); return { reglas: rules, movimientos: c.movimientos, stats: c.stats }; },
    apiSavePartidas: function (p) { D.partidas = p; return p; },
    apiReclassify: function () { var c = reclass(); return { movimientos: c.movimientos, stats: c.stats }; },
    apiSaveConfig: function (v) { Object.assign(D.config, v); return D.config; },
    apiProcessFolder: function () { return { archivos: [], stats: {} }; },
    apiInstallDailyTrigger: function () { return 'Procesado diario activado (simulado).'; },
    apiExportExcel: function () { return { id: 'x', nombre: 'Presupuesto familiar.xlsx' }; },
    apiImportExcel: function () { return { partidas: D.partidas.length, reglas: D.reglas.length, presupuesto: D.presupuesto.length }; }
  }[fn];
  return new Promise(function (ok, ko) { setTimeout(function () { try { ok(r.apply(null, args)); } catch (e) { ko(e); } }, 30); });
};
</script>`;
html = html.replace('<body>', '<body>\n' + mock);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Vista previa:', out);
