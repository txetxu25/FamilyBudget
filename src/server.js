/**
 * FamilyBudget · servidor (Google Apps Script).
 *
 * La hoja de cálculo ES el libro: mismas pestañas y columnas que el Excel original
 * (Movimientos, Reglas_Categorizacion, Maestro_Tipologias, FC) más las que escribe la app
 * (Resumen, Insights). Se puede leer y editar a mano: la app respeta los cambios.
 *
 * La web app se despliega como "Ejecutar como: usuario que accede", así cada uno entra
 * con su cuenta y solo ve datos quien tenga la hoja compartida.
 */

// ---------------------------------------------------------------- esquema

var T = {
  MOV: 'Movimientos', REG: 'Reglas_Categorizacion', MAE: 'Maestro_Tipologias', FC: 'FC',
  CFG: 'Config', ARC: 'Archivos', RES: 'Resumen', INS: 'Insights'
};

/** Cabeceras de cada pestaña, en orden. Las 8 primeras de Movimientos son las del Excel original. */
var HEADERS = {};
HEADERS[T.MOV] = ['FECHA', 'DESCRIPCION', 'TIPO MVTO', 'IMPORTE', 'MES', 'AÑO', 'CATEGORIA', 'CLASIFICACION',
  'ESTADO', 'NOTA', 'REGLA', 'SUGERENCIA', 'CONFIANZA', 'SALDO', 'FECHA VALOR', 'CONCEPTO', 'DETALLE', 'CUENTA',
  'ARCHIVO', 'ORDEN', 'CONFLICTO', 'MOTIVO', 'ASIGNADA', 'MODIFICADO', 'AUTOR', 'ID'];
HEADERS[T.REG] = ['Categoria_regla', 'Tipología', 'Clasificación', 'Comentario_defecto', 'Signo', 'Importe_min', 'Importe_max', 'Meses', 'Origen', 'Creada', 'Autor', 'ID'];
HEADERS[T.MAE] = ['Tipología', 'Clasificación', 'Tipo', 'Orden'];
HEADERS[T.FC] = ['FECHA', 'TIPO', 'IMPORTE REAL', 'IMPORTE ESTIMADO', 'TIPOLOGÍA', 'CLASIFICACIÓN', 'COMENTARIO', 'AÑO'];
HEADERS[T.CFG] = ['Campo', 'Valor'];
HEADERS[T.ARC] = ['Fichero', 'Carpeta', 'Modificado', 'Procesado', 'Movimientos', 'Nuevos', 'Resultado', 'ID'];

/** Formatos de número por cabecera (el resto, texto plano). */
var FORMATS = {
  'FECHA': 'dd/mm/yyyy', 'FECHA VALOR': 'dd/mm/yyyy', 'IMPORTE': '#,##0.00', 'SALDO': '#,##0.00', 'CONFIANZA': '0%',
  'AÑO': '0', 'IMPORTE REAL': '#,##0.00', 'IMPORTE ESTIMADO': '#,##0.00', 'Importe_min': '#,##0.00', 'Importe_max': '#,##0.00',
  'Orden': '0', 'Movimientos': '0', 'Nuevos': '0'
};
// En FC, FECHA es el nombre del mes (texto), no una fecha.
var FORMAT_OVERRIDES = { FC: { 'FECHA': '@' } };

var DEFAULT_CONFIG = {
  carpetaExtractos: '',   // carpeta de Drive con los extractos (puede tener subcarpetas por año)
  anioActivo: String(new Date().getFullYear()),
  usuarios: '',           // emails permitidos, separados por comas (vacío = quien tenga la hoja compartida)
  umbralAmbar: '0.15',
  umbralRojo: '0.3',
  minimoDesviacion: '50',
  excelCopia: '',         // fichero .xlsx de Drive donde volcar una copia (vacío = se crea al exportar)
  excelAuto: 'no'         // 'si' = exportar la copia .xlsx tras cada procesado diario
};

// ------------------------------------------------------------------ arranque

/** Ejecutar una vez desde el editor (Ejecutar ▸ setup). Crea las pestañas y guarda el ID de la hoja. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Abre el editor desde la hoja (Extensiones ▸ Apps Script) para que el script quede vinculado.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(HEADERS).forEach(function (name) { ensureSheet_(ss, name, true); }); // formatos siempre
  var cfg = readConfig_();
  var add = [];
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { if (cfg[k] === undefined) add.push([k, DEFAULT_CONFIG[k]]); });
  if (add.length) { var sh = ss.getSheetByName(T.CFG); sh.getRange(sh.getLastRow() + 1, 1, add.length, 2).setValues(add); }
  ['Hoja 1', 'Sheet1', 'Hoja1'].forEach(function (n) {
    var d = ss.getSheetByName(n);
    if (d && d.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(d);
  });
  return 'Listo. Ahora: Implementar ▸ Nueva implementación ▸ Aplicación web.';
}

/** Menú en la propia hoja, para quien trabaje desde el ordenador. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Presupuesto')
    .addItem('Procesar extractos', 'menuProcess')
    .addItem('Reclasificar y recalcular resumen', 'menuRefresh')
    .addItem('Exportar copia .xlsx', 'menuExport')
    .addSeparator()
    .addItem('Abrir la app', 'menuOpenApp')
    .addToUi();
}
function menuProcess() { var r = apiProcessFolder(); SpreadsheetApp.getActive().toast(r.archivos.length + ' fichero(s), ' + r.archivos.reduce(function (s, a) { return s + (a.nuevos || 0); }, 0) + ' movimientos nuevos.', 'Presupuesto'); }
function menuRefresh() { apiReclassify(); SpreadsheetApp.getActive().toast('Resumen e insights actualizados.', 'Presupuesto'); }
function menuExport() { var r = apiExportExcel(); SpreadsheetApp.getActive().toast('Copia guardada: ' + r.nombre, 'Presupuesto'); }
function menuOpenApp() {
  var url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(url ? '<a href="' + url + '" target="_blank" style="font:16px system-ui">Abrir la app</a>' : '<p style="font:14px system-ui">Primero publica la app: Implementar ▸ Nueva implementación ▸ Aplicación web.</p>').setWidth(320).setHeight(80), 'Presupuesto familiar');
}

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var a = SpreadsheetApp.getActiveSpreadsheet();
  if (a) return a;
  throw new Error('Falta ejecutar setup() desde el editor de Apps Script.');
}

function ensureSheet_(ss, name, force) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var hdr = HEADERS[name];
  if (!hdr) return sh;
  var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var changed = false;
  if (!cur.length || cur.join('') === '') {
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
    sh.setFrozenRows(1);
    cur = hdr; changed = true;
  } else {
    // columnas nuevas al final, sin tocar las existentes
    var have = cur.map(function (h) { return FB.norm(h); });
    var missing = hdr.filter(function (h) { return have.indexOf(FB.norm(h)) < 0; });
    if (missing.length) { sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold'); cur = cur.concat(missing); changed = true; }
  }
  if (!changed && !force) return sh;
  var over = FORMAT_OVERRIDES[name] || {};
  cur.forEach(function (h, i) {
    var f = over[h] || FORMATS[h] || '@';
    sh.getRange(2, i + 1, Math.max(1, sh.getMaxRows() - 1), 1).setNumberFormat(f);
  });
  return sh;
}

// --------------------------------------------------------------- tablas

/** Lee una pestaña como objetos {cabecera: valor}. Las fechas salen como 'YYYY-MM-DD'. */
function readTable_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return [];
  var last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2) return [];
  var values = sh.getRange(1, 1, last, cols).getValues();
  var hdr = values[0].map(function (h) { return String(h).trim(); });
  var canon = {};
  (HEADERS[name] || []).forEach(function (h) { canon[FB.norm(h)] = h; });
  hdr = hdr.map(function (h) { return canon[FB.norm(h)] || h; });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var o = {};
    for (var c = 0; c < hdr.length; c++) {
      var v = row[c];
      if (Object.prototype.toString.call(v) === '[object Date]') v = FB.ymd(v);
      o[hdr[c]] = v;
    }
    out.push(o);
  }
  return out;
}

/** Reescribe la pestaña completa conservando las cabeceras (y columnas extra) que haya. */
function writeTable_(name, rows) {
  var ss = ss_();
  var sh = ensureSheet_(ss, name);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var canon = {};
  (HEADERS[name] || []).forEach(function (h) { canon[FB.norm(h)] = h; });
  var keys = hdr.map(function (h) { return canon[FB.norm(h)] || h; });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, hdr.length).clearContent();
  if (!rows.length) return;
  var values = rows.map(function (o) { return keys.map(function (k) { var v = o[k]; return v == null ? '' : v; }); });
  if (sh.getMaxRows() < values.length + 1) {
    sh.insertRowsAfter(sh.getMaxRows(), values.length + 1 - sh.getMaxRows() + 200);
    var over = FORMAT_OVERRIDES[name] || {};
    keys.forEach(function (h, i) { sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat(over[h] || FORMATS[h] || '@'); });
  }
  sh.getRange(2, 1, values.length, keys.length).setValues(values);
}

function num_(v) {
  if (typeof v === 'number') return v;
  var n = FB.parseAmount(v);
  return isFinite(n) ? n : 0;
}
function dateOrBlank_(s) { var d = FB.toDate(s); return d || ''; }

// ---- Movimientos: hoja <-> modelo interno (importe con signo)

function readMovs_() {
  var pm = {};
  return readTable_(T.MOV).map(function (r) {
    var tipo = String(r['TIPO MVTO'] || '').trim();
    var imp = Math.abs(num_(r['IMPORTE']));
    var fecha = FB.toDate(r['FECHA']);
    var m = {
      id: String(r['ID'] || ''),
      fecha: fecha ? FB.ymd(fecha) : '',
      fechaValor: r['FECHA VALOR'] ? FB.ymd(FB.toDate(r['FECHA VALOR']) || fecha) : '',
      concepto: String(r['CONCEPTO'] || r['DESCRIPCION'] || ''),
      detalle: String(r['DETALLE'] || ''),
      importe: FB.round2(/ingreso/i.test(tipo) ? imp : -imp),
      saldo: r['SALDO'] === '' || r['SALDO'] == null ? null : num_(r['SALDO']),
      cuenta: String(r['CUENTA'] || ''), archivo: String(r['ARCHIVO'] || ''), orden: num_(r['ORDEN']),
      tipologia: String(r['CLASIFICACION'] || '').trim(),
      estado: String(r['ESTADO'] || '').trim().toLowerCase(),
      regla: String(r['REGLA'] || ''), sugerencia: String(r['SUGERENCIA'] || ''),
      confianza: r['CONFIANZA'] === '' ? '' : num_(r['CONFIANZA']),
      motivo: String(r['MOTIVO'] || ''), conflicto: String(r['CONFLICTO'] || ''), nota: String(r['NOTA'] || ''),
      asignada: r['ASIGNADA'] === undefined ? undefined : String(r['ASIGNADA'] || ''),
      modificado: String(r['MODIFICADO'] || ''), autor: String(r['AUTOR'] || '')
    };
    // fila añadida a mano en la hoja (p. ej. un gasto en efectivo): sin ID
    if (!m.id && m.fecha) {
      m.id = 'a' + FB.movementId(m).slice(1); // 'a' = añadido a mano en la hoja
      m.estado = m.tipologia ? 'manual' : 'pendiente';
      m.archivo = m.archivo || '(a mano)';
    }
    return m;
  }).filter(function (m) { return m.fecha && isFinite(m.importe); });
}

function writeMovs_(movs, partidas) {
  var pm = {};
  (partidas || readPartidas_()).forEach(function (p) { pm[p.tipologia] = p; });
  var rows = FB.chronoSort(movs).reverse().map(function (m) {
    var p = pm[m.tipologia];
    return {
      'FECHA': dateOrBlank_(m.fecha),
      'DESCRIPCION': FB.norm(m.concepto + ' ' + m.detalle),
      'TIPO MVTO': m.importe < 0 ? 'Gasto' : 'Ingreso',
      'IMPORTE': Math.abs(m.importe),
      'MES': FB.MESES[Number(m.fecha.slice(5, 7)) - 1],
      'AÑO': Number(m.fecha.slice(0, 4)),
      'CATEGORIA': p ? p.bloque : 'SIN CATEGORIA',
      'CLASIFICACION': m.tipologia || '',
      'ESTADO': m.estado || 'pendiente', 'NOTA': m.nota || '', 'REGLA': m.regla || '',
      'SUGERENCIA': m.sugerencia || '', 'CONFIANZA': m.confianza === '' || m.confianza == null ? '' : m.confianza,
      'SALDO': m.saldo == null ? '' : m.saldo, 'FECHA VALOR': dateOrBlank_(m.fechaValor),
      'CONCEPTO': m.concepto, 'DETALLE': m.detalle, 'CUENTA': m.cuenta || '', 'ARCHIVO': m.archivo || '', 'ORDEN': m.orden || 0,
      'CONFLICTO': m.conflicto || '', 'MOTIVO': m.motivo || '', 'ASIGNADA': m.asignada || '',
      'MODIFICADO': m.modificado || '', 'AUTOR': m.autor || '', 'ID': m.id
    };
  });
  writeTable_(T.MOV, rows);
}

// ---- Reglas

function readRules_() {
  return readTable_(T.REG).map(function (r) {
    return {
      id: String(r['ID'] || ''), patron: String(r['Categoria_regla'] || '').trim(), tipologia: String(r['Tipología'] || '').trim(),
      comentario: String(r['Comentario_defecto'] || ''), signo: String(r['Signo'] || '').trim(),
      min: r['Importe_min'] === '' ? '' : num_(r['Importe_min']), max: r['Importe_max'] === '' ? '' : num_(r['Importe_max']),
      meses: String(r['Meses'] || ''), origen: String(r['Origen'] || ''), creada: String(r['Creada'] || ''), autor: String(r['Autor'] || '')
    };
  }).filter(function (r) { return r.patron; });
}
function writeRules_(rules, partidas) {
  var pm = {};
  (partidas || readPartidas_()).forEach(function (p) { pm[p.tipologia] = p; });
  writeTable_(T.REG, rules.map(function (r) {
    return {
      'Categoria_regla': r.patron, 'Tipología': r.tipologia, 'Clasificación': pm[r.tipologia] ? pm[r.tipologia].bloque : '',
      'Comentario_defecto': r.comentario || '', 'Signo': r.signo || '', 'Importe_min': r.min === 0 ? 0 : (r.min || ''),
      'Importe_max': r.max === 0 ? 0 : (r.max || ''), 'Meses': r.meses || '', 'Origen': r.origen || '', 'Creada': r.creada || '',
      'Autor': r.autor || '', 'ID': r.id || Utilities.getUuid().slice(0, 8)
    };
  }));
}

// ---- Partidas (Maestro_Tipologias)

function readPartidas_() {
  return readTable_(T.MAE).map(function (r, i) {
    var tipo = String(r['Tipo'] || '');
    return {
      tipologia: String(r['Tipología'] || '').trim(), bloque: String(r['Clasificación'] || 'OTROS').trim().toUpperCase(),
      tipo: /ingreso/i.test(tipo) ? 'Ingreso' : /traspaso/i.test(tipo) ? 'Traspaso' : 'Gasto', orden: num_(r['Orden']) || i + 1
    };
  }).filter(function (p) { return p.tipologia && FB.norm(p.tipologia) !== 'SIN CLASIFICACION'; });
}
function writePartidas_(partidas) {
  writeTable_(T.MAE, partidas.map(function (p, i) { return { 'Tipología': p.tipologia, 'Clasificación': p.bloque, 'Tipo': p.tipo, 'Orden': i + 1 }; }));
}

// ---- Presupuesto (FC, formato largo del Excel: una fila por partida y mes)

function readBudget_() {
  var def = Number(config_().anioActivo);
  var out = [];
  readTable_(T.FC).forEach(function (r) {
    var mes = FB.monthIndex(r['FECHA']);
    var t = String(r['TIPOLOGÍA'] || '').trim();
    var imp = num_(r['IMPORTE ESTIMADO']);
    if (!mes || !t || !imp) return;
    out.push({ anio: num_(r['AÑO']) || def, mes: mes, tipologia: t, importe: Math.abs(imp), comentario: String(r['COMENTARIO'] || '') });
  });
  return out;
}

/** Escribe FC con la rejilla completa (partida × mes) de cada año con presupuesto, e IMPORTE REAL calculado. */
function writeBudget_(budget, partidas, movs) {
  partidas = partidas || readPartidas_();
  movs = movs || readMovs_();
  var years = {};
  budget.forEach(function (b) { years[b.anio] = 1; });
  var cell = {};
  budget.forEach(function (b) {
    var k = b.anio + '|' + b.mes + '|' + b.tipologia;
    if (cell[k]) { cell[k].importe += b.importe; if (b.comentario) cell[k].comentario = (cell[k].comentario ? cell[k].comentario + ' · ' : '') + b.comentario; }
    else cell[k] = { importe: b.importe, comentario: b.comentario || '' };
  });
  var rows = [];
  Object.keys(years).map(Number).sort().forEach(function (y) {
    var real = FB.realByLine(movs, partidas, y);
    var names = partidas.map(function (p) { return p.tipologia; });
    budget.forEach(function (b) { if (b.anio === y && names.indexOf(b.tipologia) < 0) names.push(b.tipologia); });
    var pm = {}; partidas.forEach(function (p) { pm[p.tipologia] = p; });
    for (var mes = 1; mes <= 12; mes++) {
      names.forEach(function (t) {
        var c = cell[y + '|' + mes + '|' + t] || { importe: 0, comentario: '' };
        var p = pm[t] || { tipo: 'Gasto', bloque: '' };
        rows.push({
          'FECHA': FB.MESES[mes - 1], 'TIPO': p.tipo, 'IMPORTE REAL': real[t] ? real[t][mes - 1] : 0,
          'IMPORTE ESTIMADO': FB.round2(c.importe), 'TIPOLOGÍA': t, 'CLASIFICACIÓN': p.bloque, 'COMENTARIO': c.comentario, 'AÑO': y
        });
      });
    }
  });
  writeTable_(T.FC, rows);
}

// ---- Config y archivos

function readConfig_() {
  var cfg = {};
  readTable_(T.CFG).forEach(function (r) { if (r['Campo']) cfg[String(r['Campo']).trim()] = String(r['Valor']); });
  return cfg;
}
function config_() {
  var c = readConfig_();
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { if (c[k] === undefined) c[k] = DEFAULT_CONFIG[k]; });
  return c;
}
function writeConfig_(cfg) { writeTable_(T.CFG, Object.keys(cfg).map(function (k) { return { 'Campo': k, 'Valor': cfg[k] }; })); }

function readArchivos_() {
  return readTable_(T.ARC).map(function (r) {
    return { fileId: String(r['ID'] || ''), nombre: String(r['Fichero'] || ''), carpeta: String(r['Carpeta'] || ''), modificado: String(r['Modificado'] || ''),
      procesado: String(r['Procesado'] || ''), movimientos: num_(r['Movimientos']), nuevos: num_(r['Nuevos']), resultado: String(r['Resultado'] || '') };
  });
}
function writeArchivos_(list) {
  writeTable_(T.ARC, list.map(function (a) {
    return { 'Fichero': a.nombre, 'Carpeta': a.carpeta, 'Modificado': a.modificado, 'Procesado': a.procesado, 'Movimientos': a.movimientos, 'Nuevos': a.nuevos, 'Resultado': a.resultado, 'ID': a.fileId };
  }));
}

// --------------------------------------------------------------- utilidades

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('La otra persona está guardando cambios. Vuelve a intentarlo en unos segundos.');
  try { return fn(); } finally { lock.releaseLock(); }
}

function user_() {
  try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function checkAccess_() {
  var allowed = (config_().usuarios || '').split(/[,;\s]+/).filter(Boolean).map(function (e) { return e.toLowerCase(); });
  if (!allowed.length) return;
  var me = user_().toLowerCase();
  if (allowed.indexOf(me) < 0) throw new Error('Tu cuenta (' + (me || 'desconocida') + ') no está en la lista de usuarios de la app.');
}

function umbrales_(cfg) {
  return { ambar: Number(cfg.umbralAmbar) || 0.15, rojo: Number(cfg.umbralRojo) || 0.3, minimo: Number(cfg.minimoDesviacion) || 50 };
}

/** Reclasifica, guarda movimientos y recalcula FC (real), Resumen e Insights. Devuelve los movimientos. */
function commit_(movs, opts) {
  opts = opts || {};
  var partidas = opts.partidas || readPartidas_();
  var rules = opts.reglas || readRules_();
  var c = FB.classifyAll(movs, rules, partidas);
  writeMovs_(c.movimientos, partidas);
  var budget = opts.presupuesto || readBudget_();
  writeBudget_(budget, partidas, c.movimientos);
  writeReport_(c.movimientos, partidas, budget);
  return c;
}

// --------------------------------------------------------------- informe en la hoja

/** Pestañas Resumen e Insights del año activo: lo mismo que ve la app, en la hoja. */
function writeReport_(movs, partidas, budget) {
  var cfg = config_();
  var year = Number(cfg.anioActivo) || new Date().getFullYear();
  var u = umbrales_(cfg);
  var fc = FB.forecast({ year: year, partidas: partidas, movimientos: movs, presupuesto: budget, umbrales: u });
  var hasta = fc.hasta;
  var ss = ss_();

  // ---- Resumen
  var sh = ss.getSheetByName(T.RES) || ss.insertSheet(T.RES);
  sh.clear();
  var head1 = ['Tipo', 'Bloque', 'Partida'], head2 = ['', '', ''];
  FB.MESES.forEach(function (m, i) { head1.push(m, ''); head2.push(i < hasta ? 'Real' : 'Previsión', 'Ppto'); });
  head1 = head1.concat(['Acumulado hasta ' + (hasta ? FB.MESES[hasta - 1] : '—'), '', '', 'Cierre del año', '', '', '', '']);
  head2 = head2.concat(['Real', 'Ppto', 'Desv.', 'Previsión', 'Ppto anual', 'Desv.', 'Estado', 'Cómo se prevé']);
  var rows = [], bold = [];
  var order = { Ingreso: 0, Gasto: 1, Traspaso: 2 };
  var filas = fc.filas.slice().sort(function (a, b) { return order[a.tipo] - order[b.tipo] || (a.bloque < b.bloque ? -1 : a.bloque > b.bloque ? 1 : 0) || Math.abs(b.desvCierre) - Math.abs(a.desvCierre); });
  var ESTADO = { ok: 'En línea', aviso: 'Vigilar', alerta: 'Desviado', 'sin-ppto': 'Sin presupuesto' };
  var line = function (tipo, bloque, nombre, serie, ppto, rY, pY, cierre, pA, estado, como) {
    var r = [tipo, bloque, nombre];
    for (var i = 0; i < 12; i++) r.push(FB.round2(serie[i]), FB.round2(ppto[i]));
    return r.concat([FB.round2(rY), FB.round2(pY), FB.round2(rY - pY), FB.round2(cierre), FB.round2(pA), FB.round2(cierre - pA), estado, como]);
  };
  var sumTo = function (a, n) { var s = 0; for (var i = 0; i < n; i++) s += a[i] || 0; return s; };
  var lastKey = null, acc = null;
  var flush = function () {
    if (!acc) return;
    rows.push(line(acc.tipo, acc.bloque, 'Total ' + acc.bloque, acc.serie, acc.ppto, sumTo(acc.real, hasta), sumTo(acc.ppto, hasta), acc.cierre, acc.pA,
      ESTADO[FB.status(acc.tipo, acc.cierre, acc.pA, u)], ''));
    bold.push(rows.length);
  };
  filas.forEach(function (f) {
    var key = f.tipo + '|' + f.bloque;
    if (key !== lastKey) { flush(); lastKey = key; acc = { tipo: f.tipo, bloque: f.bloque, serie: [0,0,0,0,0,0,0,0,0,0,0,0], ppto: [0,0,0,0,0,0,0,0,0,0,0,0], real: [0,0,0,0,0,0,0,0,0,0,0,0], cierre: 0, pA: 0 }; }
    for (var i = 0; i < 12; i++) { acc.serie[i] += f.serie[i]; acc.ppto[i] += f.ppto[i]; acc.real[i] += f.real[i]; }
    acc.cierre += f.cierre; acc.pA += f.pptoAnual;
    rows.push(line(f.tipo, f.bloque, f.tipologia, f.serie, f.ppto, f.realYTD, sumTo(f.ppto, hasta), f.cierre, f.pptoAnual, ESTADO[f.estadoCierre] || '', f.detalle));
  });
  flush();
  rows.push(new Array(head1.length).fill(''));
  ['Ingreso', 'Gasto', 'Traspaso'].forEach(function (t) {
    var X = fc.totales[t];
    var real = X.serie.slice(0, hasta);
    rows.push(line(t, 'TOTAL', 'Total ' + t.toLowerCase() + 's', X.serie, X.ppto, sumTo(real, hasta), sumTo(X.ppto, hasta), X.cierre, X.pptoAnual, ESTADO[FB.status(t, X.cierre, X.pptoAnual, u)], ''));
    bold.push(rows.length);
  });
  rows.push(line('', 'TOTAL', 'Ahorro (ingresos − gastos − traspasos)', fc.neto.serie, fc.neto.ppto, sumTo(fc.neto.serie, hasta), sumTo(fc.neto.ppto, hasta), fc.neto.cierre, fc.neto.pptoAnual,
    ESTADO[FB.status('Ingreso', fc.neto.cierre, fc.neto.pptoAnual, u)], ''));
  bold.push(rows.length);

  sh.getRange(1, 1).setValue('Resumen ' + year + ' · real hasta ' + (hasta ? FB.MESES[hasta - 1] : '—') + ', previsión hasta diciembre · actualizado ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') + ' · lo escribe la app: no edites aquí').setFontStyle('italic').setFontColor('#52514e');
  sh.getRange(3, 1, 1, head1.length).setValues([head1]).setFontWeight('bold');
  sh.getRange(4, 1, 1, head2.length).setValues([head2]).setFontWeight('bold').setFontColor('#52514e');
  if (rows.length) {
    sh.getRange(5, 1, rows.length, head1.length).setValues(rows);
    sh.getRange(5, 4, rows.length, head1.length - 5).setNumberFormat('#,##0;-#,##0;""');
    bold.forEach(function (r) { sh.getRange(4 + r, 1, 1, head1.length).setFontWeight('bold').setBackground('#f3f2ee'); });
    // previsión en gris y cursiva
    for (var m = hasta; m < 12; m++) sh.getRange(5, 4 + 2 * m, rows.length, 1).setFontColor('#898781').setFontStyle('italic');
  }
  sh.setFrozenRows(4); sh.setFrozenColumns(3);

  // ---- Insights
  var ins = ss.getSheetByName(T.INS) || ss.insertSheet(T.INS);
  ins.clear();
  var out = [['Periodo', 'Partida', 'Bloque', 'Real', 'Presupuesto', 'Desviación', 'Efecto en el ahorro', 'Por qué']];
  var add = function (label, desde, h) {
    FB.topDeviations({ year: year, partidas: partidas, movimientos: movs, presupuesto: budget, desde: desde, hasta: h, umbrales: u, minimo: u.minimo, limit: 10 }).forEach(function (e) {
      out.push([label, e.tipologia, e.bloque || '', e.real, e.ppto, e.desv, -e.impacto, e.causas.map(function (c) { return '• ' + c.texto; }).join('\n')]);
    });
  };
  if (hasta) {
    add('Enero – ' + FB.MESES[hasta - 1], 1, hasta);
    add(FB.MESES[hasta - 1].charAt(0).toUpperCase() + FB.MESES[hasta - 1].slice(1), hasta, hasta);
  }
  out.push(['', '', '', '', '', '', '', '']);
  out.push(['Cierre previsto', 'Ahorro', '', fc.neto.cierre, fc.neto.pptoAnual, FB.round2(fc.neto.cierre - fc.neto.pptoAnual), FB.round2(fc.neto.cierre - fc.neto.pptoAnual),
    'Lo que más mueve el cierre: ' + fc.palancas.slice(0, 5).map(function (p) { return p.tipologia + ' (' + FB.fmtSigned(-p.impacto) + ')'; }).join(', ')]);
  ins.getRange(1, 1, out.length, 8).setValues(out);
  ins.getRange(1, 1, 1, 8).setFontWeight('bold');
  ins.getRange(2, 4, out.length - 1, 4).setNumberFormat('#,##0;-#,##0');
  ins.getRange(2, 8, out.length - 1, 1).setWrap(true);
  ins.setColumnWidth(8, 620); ins.setFrozenRows(1);
}

// --------------------------------------------------------------- web app

function doGet() {
  try { checkAccess_(); } catch (e) {
    return HtmlService.createHtmlOutput('<p style="font:16px system-ui;padding:24px">' + e.message + '</p>');
  }
  // Index.html ya viene con estilos y scripts incrustados por el build (un solo fichero que pegar)
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Presupuesto familiar')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/** Todo lo que necesita el cliente para pintar. El cálculo se hace en el navegador con el mismo núcleo. */
function apiBootstrap() {
  checkAccess_();
  var movs = readMovs_();
  // si alguien editó la hoja a mano, el estado se recalcula al vuelo (sin escribir)
  var partidas = readPartidas_(), reglas = readRules_();
  var c = FB.classifyAll(movs, reglas, partidas);
  return {
    usuario: user_(), config: config_(), partidas: partidas, presupuesto: readBudget_(), reglas: reglas,
    movimientos: c.movimientos, archivos: readArchivos_(), hojaUrl: ss_().getUrl()
  };
}

// ------------------------------------------------------ procesado de extractos

function apiProcessFolder() {
  checkAccess_();
  return withLock_(function () { return processFolder_(); });
}

function processFolder_() {
  var cfg = config_();
  if (!cfg.carpetaExtractos) throw new Error('Configura la carpeta de extractos en Ajustes.');
  var root = DriveApp.getFolderById(extractId_(cfg.carpetaExtractos));
  var known = {};
  readArchivos_().forEach(function (a) { known[a.fileId] = a; });
  var files = [];
  collectFiles_(root, root.getName(), files, 0);

  var movs = readMovs_();
  var ids = {};
  movs.forEach(function (m) { ids[m.id] = true; });
  var report = [];
  files.forEach(function (f) {
    var mod = f.file.getLastUpdated().toISOString();
    var prev = known[f.file.getId()];
    if (prev && prev.modificado === mod && /^ok/.test(prev.resultado)) return;
    var entry = { fileId: f.file.getId(), nombre: f.file.getName(), carpeta: f.path, modificado: mod, procesado: new Date().toISOString(), movimientos: 0, nuevos: 0, resultado: '' };
    try {
      var parsed = FB.parseStatement(readGrid_(f.file), f.file.getName());
      var nuevos = 0;
      parsed.movimientos.forEach(function (m) {
        m.id = FB.movementId(m);
        if (ids[m.id]) return;
        ids[m.id] = true;
        m.estado = 'pendiente'; m.tipologia = '';
        movs.push(m); nuevos++;
      });
      entry.movimientos = parsed.movimientos.length; entry.nuevos = nuevos; entry.resultado = 'ok';
    } catch (e) {
      entry.resultado = 'error: ' + e.message;
    }
    known[entry.fileId] = entry;
    report.push(entry);
  });
  var c = commit_(movs);
  writeArchivos_(Object.keys(known).map(function (k) { return known[k]; }));
  return { archivos: report, stats: c.stats };
}

function extractId_(s) {
  var m = String(s).match(/[-\w]{25,}/);
  return m ? m[0] : String(s).trim();
}

var STATEMENT_TYPES = ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/vnd.google-apps.spreadsheet'];

function collectFiles_(folder, path, out, depth) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (STATEMENT_TYPES.indexOf(f.getMimeType()) >= 0) out.push({ file: f, path: path });
  }
  if (depth >= 2) return;
  var sub = folder.getFolders();
  while (sub.hasNext()) { var s = sub.next(); collectFiles_(s, path + '/' + s.getName(), out, depth + 1); }
}

/** Primera hoja del fichero como rejilla de valores. Los .xls/.xlsx se convierten en una copia temporal. */
function readGrid_(file) {
  var mime = file.getMimeType();
  if (mime === 'text/csv') {
    var txt = file.getBlob().getDataAsString('ISO-8859-1');
    var first = txt.split('\n')[0];
    var sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    return Utilities.parseCsv(txt, sep);
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') return SpreadsheetApp.openById(file.getId()).getSheets()[0].getDataRange().getValues();
  var tmp = Drive.Files.create({ name: '[tmp] ' + file.getName(), mimeType: 'application/vnd.google-apps.spreadsheet' }, file.getBlob());
  try {
    return SpreadsheetApp.openById(tmp.id).getSheets()[0].getDataRange().getValues();
  } finally {
    Drive.Files.remove(tmp.id);
  }
}

// ------------------------------------------------------------ clasificación

/**
 * Asigna partida a uno o varios movimientos (manual).
 * opts.regla = {patron, signo, min, max, meses} crea además una regla y la aplica a todo lo no manual.
 */
function apiClassify(ids, tipologia, opts) {
  checkAccess_();
  opts = opts || {};
  return withLock_(function () {
    var me = user_(), now = new Date().toISOString();
    var set = {};
    (ids || []).forEach(function (id) { set[id] = true; });
    var movs = readMovs_();
    var rules = readRules_();
    var newRule = !!(opts.regla && opts.regla.patron && tipologia);
    movs.forEach(function (m) {
      if (!set[m.id]) return;
      // con regla nueva, el movimiento se deja a la regla (si la regla cambia, lo arrastra);
      // sin regla, queda fijado a mano
      m.tipologia = newRule ? '' : (tipologia || '');
      m.estado = !newRule && tipologia ? 'manual' : 'pendiente';
      m.asignada = newRule ? undefined : m.tipologia;
      if (opts.nota !== undefined) m.nota = opts.nota;
      m.modificado = now; m.autor = me;
    });
    if (newRule) {
      rules.push({
        id: Utilities.getUuid().slice(0, 8), patron: String(opts.regla.patron).trim(), tipologia: tipologia,
        signo: opts.regla.signo || '', min: opts.regla.min || '', max: opts.regla.max || '', meses: opts.regla.meses || '',
        comentario: opts.regla.comentario || '', origen: 'app', creada: now, autor: me
      });
      writeRules_(rules);
      // si la regla (por sus condiciones) no casa con alguno de los elegidos, ese queda fijado a mano
      var partidas = readPartidas_();
      movs = FB.classifyAll(movs, rules, partidas).movimientos;
      movs.forEach(function (m) {
        if (set[m.id] && m.tipologia !== tipologia) { m.tipologia = tipologia; m.estado = 'manual'; m.asignada = tipologia; }
      });
    }
    var c = commit_(movs, { reglas: rules });
    return { stats: c.stats, movimientos: c.movimientos, reglas: rules };
  });
}

function apiAcceptSuggestions(ids) {
  checkAccess_();
  return withLock_(function () {
    var set = {}; ids.forEach(function (id) { set[id] = true; });
    var me = user_(), now = new Date().toISOString();
    var movs = readMovs_();
    movs.forEach(function (m) {
      if (!set[m.id]) return;
      var t = m.tipologia || m.sugerencia;
      if (!t) return;
      m.tipologia = t; m.estado = 'manual'; m.asignada = t; m.modificado = now; m.autor = me;
    });
    var c = commit_(movs);
    return { stats: c.stats, movimientos: c.movimientos };
  });
}

/** Guarda la lista completa de reglas y reclasifica todo lo que no es manual. */
function apiSaveRules(rules) {
  checkAccess_();
  return withLock_(function () {
    var clean = (rules || []).filter(function (r) { return r.patron && r.tipologia; }).map(function (r) {
      return { id: r.id || Utilities.getUuid().slice(0, 8), patron: String(r.patron).trim(), tipologia: r.tipologia, signo: r.signo || '', min: r.min === 0 ? 0 : (r.min || ''), max: r.max === 0 ? 0 : (r.max || ''), meses: r.meses || '', comentario: r.comentario || '', origen: r.origen || 'app', creada: r.creada || new Date().toISOString(), autor: r.autor || user_() };
    });
    writeRules_(clean);
    var c = commit_(readMovs_(), { reglas: clean });
    return { stats: c.stats, movimientos: c.movimientos, reglas: clean };
  });
}

function apiSavePartidas(partidas) {
  checkAccess_();
  return withLock_(function () {
    var clean = (partidas || []).filter(function (p) { return p.tipologia; }).map(function (p) {
      return { tipologia: String(p.tipologia).trim(), bloque: String(p.bloque || 'OTROS').trim().toUpperCase(), tipo: FB.TIPOS.indexOf(p.tipo) >= 0 ? p.tipo : 'Gasto' };
    });
    writePartidas_(clean);
    var c = commit_(readMovs_(), { partidas: clean });
    return { partidas: clean, movimientos: c.movimientos };
  });
}

/** Sustituye el presupuesto de un año por las celdas recibidas [{mes, tipologia, importe, comentario}]. */
function apiSaveBudget(anio, celdas) {
  checkAccess_();
  return withLock_(function () {
    anio = Number(anio);
    var others = readBudget_().filter(function (b) { return b.anio !== anio; });
    var mine = (celdas || []).filter(function (c) { return Number(c.importe); }).map(function (c) {
      return { anio: anio, mes: Number(c.mes), tipologia: c.tipologia, importe: FB.round2(c.importe), comentario: c.comentario || '' };
    });
    var budget = others.concat(mine);
    commit_(readMovs_(), { presupuesto: budget });
    return readBudget_();
  });
}

function apiSaveConfig(values) {
  checkAccess_();
  return withLock_(function () {
    var cfg = config_();
    var changedYear = values && values.anioActivo !== undefined && String(values.anioActivo) !== cfg.anioActivo;
    Object.keys(values || {}).forEach(function (k) { if (k in DEFAULT_CONFIG) cfg[k] = String(values[k]); });
    writeConfig_(cfg);
    if (changedYear) writeReport_(readMovs_(), readPartidas_(), readBudget_());
    return cfg;
  });
}

function apiReclassify() {
  checkAccess_();
  return withLock_(function () {
    var c = commit_(readMovs_());
    return { stats: c.stats, movimientos: c.movimientos };
  });
}

// ------------------------------------------------- importación del Excel antiguo

/**
 * Importa partidas, reglas y presupuesto desde el libro BUDGET_HOME.xlsx (en Drive).
 * modo: 'reemplazar' borra lo que hubiera; 'anadir' solo añade lo que falte.
 */
function apiImportExcel(fileIdOrUrl, anio, modo) {
  checkAccess_();
  return withLock_(function () {
    var file = DriveApp.getFileById(extractId_(fileIdOrUrl));
    var grids = {};
    var read = function (book) {
      ['Maestro_Tipologias', 'Reglas_Categorizacion', 'FC'].forEach(function (n) {
        var sh = book.getSheetByName(n);
        grids[n] = sh ? sh.getDataRange().getValues() : [];
      });
    };
    if (file.getMimeType() === 'application/vnd.google-apps.spreadsheet') read(SpreadsheetApp.openById(file.getId()));
    else {
      var tmp = Drive.Files.create({ name: '[tmp] ' + file.getName(), mimeType: 'application/vnd.google-apps.spreadsheet' }, file.getBlob());
      try { read(SpreadsheetApp.openById(tmp.id)); } finally { Drive.Files.remove(tmp.id); }
    }
    var data = FB.importFromBudgetWorkbook(grids, Number(anio));
    var replace = modo !== 'anadir';
    var partidas = replace ? [] : readPartidas_();
    var have = {}; partidas.forEach(function (p) { have[FB.norm(p.tipologia)] = true; });
    data.partidas.forEach(function (p) { if (!have[FB.norm(p.tipologia)]) { partidas.push(p); have[FB.norm(p.tipologia)] = true; } });
    writePartidas_(partidas);

    var rules = replace ? [] : readRules_();
    var haveR = {}; rules.forEach(function (r) { haveR[FB.norm(r.patron) + '|' + r.tipologia] = true; });
    var now = new Date().toISOString();
    data.reglas.forEach(function (r) {
      if (haveR[FB.norm(r.patron) + '|' + r.tipologia]) return;
      r.id = Utilities.getUuid().slice(0, 8); r.creada = now; r.autor = user_();
      rules.push(r);
    });
    writeRules_(rules, partidas);

    var budget = readBudget_().filter(function (b) { return b.anio !== Number(anio); }).concat(data.presupuesto);
    var c = commit_(readMovs_(), { partidas: partidas, reglas: rules, presupuesto: budget });
    return { partidas: partidas.length, reglas: rules.length, presupuesto: data.presupuesto.length, stats: c.stats };
  });
}

// ------------------------------------------------------------ copia .xlsx

/**
 * Vuelca una copia de la hoja completa en un .xlsx de Drive (solo lectura: lo que se edite
 * en ese .xlsx no vuelve a la app). Si no hay destino configurado, crea uno junto a la hoja.
 */
function apiExportExcel() {
  checkAccess_();
  return exportExcel_();
}

function exportExcel_() {
  var ss = ss_();
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Google no ha podido exportar la hoja (' + resp.getResponseCode() + ').');
  var cfg = config_();
  var name = ss.getName() + '.xlsx';
  var blob = resp.getBlob().setName(name).setContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  var file;
  if (cfg.excelCopia) {
    file = Drive.Files.update({}, extractId_(cfg.excelCopia), blob);
  } else {
    var parent = DriveApp.getFileById(ss.getId()).getParents();
    var meta = { name: name };
    if (parent.hasNext()) meta.parents = [parent.next().getId()];
    file = Drive.Files.create(meta, blob);
    cfg.excelCopia = file.id;
    writeConfig_(cfg);
  }
  return { id: file.id, nombre: file.name || name, url: 'https://drive.google.com/file/d/' + file.id + '/view' };
}

// ----------------------------------------------------------------- disparador

/** Instala (una vez) el procesado diario. Se ejecuta con la cuenta de quien lo instala. */
function apiInstallDailyTrigger() {
  checkAccess_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyProcess') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyProcess').timeBased().everyDays(1).atHour(7).create();
  return 'Procesado diario activado (sobre las 7:00).';
}

function dailyProcess() {
  withLock_(function () {
    if (config_().carpetaExtractos) processFolder_();
    else commit_(readMovs_());
    if (config_().excelAuto === 'si') exportExcel_();
  });
}
