// El servidor de Apps Script ejecutado contra una simulación en memoria (test/gas-mock.js). Datos sintéticos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer, grid } = require('./gas-mock.js');

/** Libro de presupuesto de un año (fichero aparte en la carpeta del año) y su ubicación. */
function budgetBook(ctx, year) {
  const f = ctx.__files.find((x) => x.name === 'Presupuesto_' + year && x.mime === 'application/vnd.google-apps.spreadsheet');
  return f ? { file: f, book: ctx.__spreadsheets[f.id], grid: ctx.__spreadsheets[f.id].getSheetByName('FC').getDataRange().getValues() } : null;
}

const serial = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000 + 25569);
const HEAD = [['Movimientos de la cuenta ES00 0000 0000 0000 0000 4321', '', '', '', '', ''], ['Importes en euros', '', '', '', '', ''], ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo']];

function statement(rows, start) {
  // rows: [y, m, d, concepto, detalle, importe] en orden cronológico; se calculan saldos y se invierte (más reciente primero)
  let saldo = start === undefined ? 1000 : start;
  const out = rows.map((r) => { saldo = Math.round((saldo + r[5]) * 100) / 100; return [serial(r[0], r[1], r[2]), serial(r[0], r[1], r[2]), r[3], r[4], r[5], saldo]; });
  return HEAD.concat(out.reverse());
}

const EXCEL = {
  Maestro_Tipologias: [
    ['MAESTRO', null, null, null], ['Tipología', 'Clasificación (bloque)', 'Tipo', 'Naturaleza'],
    ['Nómina', 'INGRESOS', 'Ingreso', 'Ingreso'], ['Supermercado', 'DESPENSA', 'Gasto', 'Consumo'], ['Ocio', 'OCIO', 'Gasto', 'Consumo']
  ],
  Reglas_Categorizacion: [['Categoria_regla', 'Tipología', 'Clasificación', 'Comentario_defecto'], ['NOMINA', 'Nómina', 'INGRESOS', null], ['SUPER', 'Supermercado', 'DESPENSA', null]],
  FC: [['FECHA', 'TIPO ', 'IMPORTE REAL ', 'IMPORTE ESTIMADO', 'TIPOLOGÍA', 'CLASIFICACIÓN', 'COMENTARIO']]
    .concat(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].flatMap((m) => [
      [m, 'Ingreso', null, 2000, 'Nómina', 'INGRESOS', null], [m, 'Gasto', null, 300, 'Supermercado', 'DESPENSA', null], [m, 'Gasto', null, 50, 'Ocio', 'OCIO', null]]))
};

function setupCtx() {
  const files = [
    { id: 'XL', name: 'BUDGET_HOME.xlsx', folder: 'Otros', sheets: EXCEL, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { id: 'F1', name: 'ene.xls', folder: 'Extractos/2026', grid: statement([[2026, 1, 2, 'SUPER UNO', 'x', -100], [2026, 1, 20, 'BAR PEPE', 'x', -30], [2026, 1, 28, 'NOMINA', 'EMPRESA', 2000]]) },
    { id: 'F2', name: 'feb.xls', folder: 'Extractos/2026', grid: statement([[2026, 1, 28, 'NOMINA', 'EMPRESA', 2000], [2026, 2, 3, 'SUPER UNO', 'x', -400], [2026, 2, 27, 'NOMINA', 'EMPRESA', 2000]], 870) }
  ];
  const ctx = loadServer({ files, rootFolder: { id: 'ROOTFOLDERID_ABCDEFGHIJKLMNOPQ', name: 'Extractos' } });
  ctx.setup();
  return ctx;
}

test('setup crea las pestañas con las columnas del Excel original', () => {
  const ctx = setupCtx();
  const mov = grid(ctx, 'Movimientos')[0];
  assert.deepEqual(mov.slice(0, 8), ['FECHA', 'DESCRIPCION', 'TIPO MVTO', 'IMPORTE', 'MES', 'AÑO', 'CATEGORIA', 'CLASIFICACION']);
  assert.equal(grid(ctx, 'Hoja 1'), null, 'la hoja vacía por defecto se borra');
  assert.ok(grid(ctx, 'Config').some((r) => r[0] === 'carpetaExtractos'));
});

test('flujo completo: importar Excel, procesar extractos, clasificar, informe', () => {
  const ctx = setupCtx();
  ctx.apiSaveConfig({ carpetaExtractos: 'https://drive.google.com/drive/folders/ROOTFOLDERID_ABCDEFGHIJKLMNOPQ', anioActivo: '2026' });
  const imp = ctx.apiImportExcel('XL', 2026, 'reemplazar');
  assert.equal(imp.partidas, 3);
  assert.equal(imp.reglas, 2);
  assert.equal(imp.presupuesto, 36);

  const r = ctx.apiProcessFolder();
  assert.equal(r.archivos.length, 2);
  const nuevos = r.archivos.reduce((s, a) => s + a.nuevos, 0);
  assert.equal(nuevos, 5, 'la nómina de enero repetida en los dos extractos cuenta una vez');

  // segunda pasada: nada nuevo
  assert.equal(ctx.apiProcessFolder().archivos.length, 0);

  const b = ctx.apiBootstrap();
  assert.equal(b.movimientos.length, 5);
  const bar = b.movimientos.find((m) => m.concepto === 'BAR PEPE');
  assert.equal(bar.estado, 'pendiente');
  assert.equal(b.movimientos.find((m) => m.concepto === 'SUPER UNO' && m.importe === -400).tipologia, 'Supermercado');

  // la hoja Movimientos tiene fechas reales, importes en valor absoluto y bloque
  const g = grid(ctx, 'Movimientos');
  const h = g[0];
  const row = g.find((x) => x[h.indexOf('CONCEPTO')] === 'SUPER UNO' && x[h.indexOf('IMPORTE')] === 400);
  assert.equal(Object.prototype.toString.call(row[h.indexOf('FECHA')]), '[object Date]');
  assert.equal(row[h.indexOf('TIPO MVTO')], 'Gasto');
  assert.equal(row[h.indexOf('CATEGORIA')], 'DESPENSA');
  assert.equal(row[h.indexOf('MES')], 'febrero');

  // el presupuesto vive en Extractos/2026/Presupuesto_2026 (formato largo de FC) con IMPORTE REAL relleno
  assert.equal(grid(ctx, 'FC'), null, 'el libro principal ya no tiene pestaña FC');
  const bb = budgetBook(ctx, 2026);
  assert.equal(bb.file.folder, 'Extractos/2026');
  const fc = bb.grid;
  const fh = fc[0];
  const febSup = fc.find((x) => x[fh.indexOf('FECHA')] === 'febrero' && x[fh.indexOf('TIPOLOGÍA')] === 'Supermercado');
  assert.equal(febSup[fh.indexOf('IMPORTE ESTIMADO')], 300);
  assert.equal(febSup[fh.indexOf('IMPORTE REAL')], 400);

  // Resumen e Insights escritos
  const res = grid(ctx, 'Resumen');
  assert.match(String(res[0][0]), /Resumen 2026/);
  assert.ok(res.some((x) => x[2] === 'Supermercado'));
  assert.ok(res.some((x) => /Ahorro/.test(x[2])));
  const ins = grid(ctx, 'Insights');
  assert.ok(ins.some((x) => x[1] === 'Supermercado' && /./.test(x[7])), 'hay explicación para Supermercado');
});

test('clasificar desde la app con regla nueva, y respetar una edición hecha a mano en la hoja', () => {
  const ctx = setupCtx();
  ctx.apiSaveConfig({ carpetaExtractos: 'ROOTFOLDERID_ABCDEFGHIJKLMNOPQ', anioActivo: '2026' });
  ctx.apiImportExcel('XL', 2026, 'reemplazar');
  ctx.apiProcessFolder();
  const bar = ctx.apiBootstrap().movimientos.find((m) => m.concepto === 'BAR PEPE');
  const r = ctx.apiClassify([bar.id], 'Ocio', { regla: { patron: 'BAR PEPE' }, nota: 'cumple' });
  const after = r.movimientos.find((m) => m.id === bar.id);
  assert.equal(after.tipologia, 'Ocio');
  assert.equal(after.estado, 'regla', 'queda ligado a la regla, no fijado a mano');
  assert.equal(after.nota, 'cumple');
  assert.ok(grid(ctx, 'Reglas_Categorizacion').some((x) => x[0] === 'BAR PEPE' && x[1] === 'Ocio' && x[2] === 'OCIO'));

  // alguien cambia en la hoja la partida de una compra del súper a "Ocio"
  const sh = ctx.__book.getSheetByName('Movimientos');
  const g = grid(ctx, 'Movimientos'), h = g[0];
  const i = g.findIndex((x) => x[h.indexOf('CONCEPTO')] === 'SUPER UNO' && x[h.indexOf('IMPORTE')] === 100);
  sh.set(i + 1, h.indexOf('CLASIFICACION') + 1, 'Ocio');
  const re = ctx.apiReclassify();
  const edited = re.movimientos.find((m) => m.concepto === 'SUPER UNO' && m.importe === -100);
  assert.equal(edited.tipologia, 'Ocio');
  assert.equal(edited.estado, 'manual');

  // y añade a mano un gasto en efectivo (sin ID)
  const last = sh.getLastRow() + 1;
  sh.set(last, h.indexOf('FECHA') + 1, new Date(2026, 1, 10, 12));
  sh.set(last, h.indexOf('TIPO MVTO') + 1, 'Gasto');
  sh.set(last, h.indexOf('IMPORTE') + 1, 25);
  sh.set(last, h.indexOf('DESCRIPCION') + 1, 'Mercadillo en efectivo');
  sh.set(last, h.indexOf('CLASIFICACION') + 1, 'Supermercado');
  const b = ctx.apiBootstrap();
  const cash = b.movimientos.find((m) => m.concepto === 'Mercadillo en efectivo');
  assert.ok(cash && cash.id, 'se lee y recibe id');
  assert.equal(cash.importe, -25);
  assert.equal(cash.estado, 'manual');
  ctx.apiReclassify();
  assert.equal(ctx.apiBootstrap().movimientos.filter((m) => m.concepto === 'Mercadillo en efectivo').length, 1, 'no se duplica al reescribir');
});

test('presupuesto editado en la app se guarda en su fichero anual y lo editado en ese fichero se lee', () => {
  const ctx = setupCtx();
  assert.throws(() => ctx.apiSaveBudget(2026, [{ mes: 1, tipologia: 'Ocio', importe: 75 }]), /carpeta de extractos/);
  ctx.apiSaveConfig({ anioActivo: '2026', carpetaExtractos: 'ROOTFOLDERID_ABCDEFGHIJKLMNOPQ' });
  ctx.apiImportExcel('XL', 2026, 'reemplazar');
  const b = ctx.apiSaveBudget(2026, [{ mes: 1, tipologia: 'Ocio', importe: 75 }, { mes: 2, tipologia: 'Supermercado', importe: 310 }]);
  assert.equal(b.length, 2);
  // un año nuevo crea su carpeta y su fichero
  ctx.apiSaveBudget(2027, [{ mes: 1, tipologia: 'Ocio', importe: 80 }]);
  assert.equal(budgetBook(ctx, 2027).file.folder, 'Extractos/2027');
  assert.equal(ctx.apiBootstrap().presupuesto.filter((x) => x.anio === 2027).length, 1);
  const bb = budgetBook(ctx, 2026);
  const fc = bb.grid, fh = fc[0];
  const sh = bb.book.getSheetByName('FC');
  const i = fc.findIndex((x) => x[fh.indexOf('FECHA')] === 'marzo' && x[fh.indexOf('TIPOLOGÍA')] === 'Ocio');
  sh.set(i + 1, fh.indexOf('IMPORTE ESTIMADO') + 1, 90);
  const pres = ctx.apiBootstrap().presupuesto;
  assert.ok(pres.some((p) => p.mes === 3 && p.tipologia === 'Ocio' && p.importe === 90));
});

test('exportar copia .xlsx crea el fichero la primera vez y lo actualiza después', () => {
  const ctx = setupCtx();
  const a = ctx.apiExportExcel();
  assert.ok(a.id);
  const b = ctx.apiExportExcel();
  assert.equal(b.id, a.id);
  assert.equal(ctx.__exported.filter((e) => e.update).length, 1);
});

test('si la carpeta configurada es la de un año, se leen todos los años (y no se procesa el presupuesto como extracto)', () => {
  const files = [
    { id: 'XL', name: 'BUDGET_HOME.xlsx', folder: 'Otros', sheets: EXCEL, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { id: 'A25', name: 'cuenta_2025.xls', folder: 'Extractos/2025', grid: statement([[2025, 5, 2, 'SUPER UNO', 'x', -90]], 700) },
    { id: 'A26', name: 'ene.xls', folder: 'Extractos/2026', grid: statement([[2026, 1, 2, 'SUPER UNO', 'x', -100]]) }
  ];
  const ctx = loadServer({ files, rootFolder: { id: 'ROOTFOLDERID_ABCDEFGHIJKLMNOPQ', name: 'Extractos' } });
  ctx.setup();
  ctx.apiSaveConfig({ carpetaExtractos: 'FOLDER:Extractos/2026', anioActivo: '2026' }); // apunta a la carpeta del año
  ctx.apiImportExcel('XL', 2026, 'reemplazar');
  const r = ctx.apiProcessFolder();
  assert.equal(JSON.stringify(r.archivos.map((a) => a.nombre + ':' + a.resultado).sort()), JSON.stringify(['cuenta_2025.xls:ok', 'ene.xls:ok']));
  assert.ok(ctx.apiBootstrap().movimientos.some((m) => m.fecha.startsWith('2025')), '2025 cargado aunque no tenga presupuesto');
  assert.ok(budgetBook(ctx, 2026), 'el presupuesto 2026 está en su carpeta');
  // el fichero de presupuesto (una hoja de Google en la carpeta 2026) no se toma por un extracto
  assert.equal(ctx.apiProcessFolder().archivos.length, 0);
});

test('migra la pestaña FC antigua del libro principal a ficheros anuales y la elimina', () => {
  const ctx = setupCtx();
  ctx.apiSaveConfig({ anioActivo: '2026' });
  // libro "antiguo": pestaña FC en el libro principal
  const fcSheet = ctx.__book.insertSheet('FC');
  [['FECHA', 'TIPO', 'IMPORTE REAL', 'IMPORTE ESTIMADO', 'TIPOLOGÍA', 'CLASIFICACIÓN', 'COMENTARIO', 'AÑO'],
    ['enero', 'Gasto', '', 300, 'Supermercado', 'DESPENSA', 'x', 2026], ['marzo', 'Gasto', '', 50, 'Ocio', 'OCIO', '', 2025]]
    .forEach((row, i) => row.forEach((v, j) => fcSheet.set(i + 1, j + 1, v)));
  ctx.apiSaveConfig({ carpetaExtractos: 'ROOTFOLDERID_ABCDEFGHIJKLMNOPQ' });
  const pres = ctx.apiBootstrap().presupuesto;
  assert.equal(grid(ctx, 'FC'), null, 'pestaña FC eliminada del libro principal');
  assert.ok(budgetBook(ctx, 2026) && budgetBook(ctx, 2025));
  assert.ok(pres.some((b) => b.anio === 2026 && b.tipologia === 'Supermercado' && b.importe === 300));
  assert.ok(pres.some((b) => b.anio === 2025 && b.tipologia === 'Ocio' && b.importe === 50));
});
