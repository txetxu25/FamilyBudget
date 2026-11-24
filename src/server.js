/**
 * FamilyBudget · servidor (Google Apps Script).
 *
 * Los datos viven en una hoja de cálculo privada (la que contiene este script).
 * El acceso lo da Google: quien no tenga la hoja compartida no puede leer nada.
 * La web app se despliega como "Ejecutar como: usuario que accede", así cada
 * uno entra con su cuenta y Session.getActiveUser() funciona en cuentas Gmail.
 */

var SHEETS = {
  Config: ['clave', 'valor'],
  Partidas: ['tipologia', 'bloque', 'tipo', 'orden'],
  Presupuesto: ['anio', 'mes', 'tipologia', 'importe', 'comentario'],
  Reglas: ['id', 'patron', 'tipologia', 'signo', 'min', 'max', 'meses', 'comentario', 'origen', 'creada', 'autor'],
  Movimientos: ['id', 'fecha', 'fechaValor', 'concepto', 'detalle', 'importe', 'saldo', 'cuenta', 'archivo', 'orden',
    'tipologia', 'estado', 'regla', 'sugerencia', 'confianza', 'motivo', 'conflicto', 'nota', 'modificado', 'autor'],
  Archivos: ['fileId', 'nombre', 'carpeta', 'modificado', 'procesado', 'movimientos', 'nuevos', 'resultado']
};

var DEFAULT_CONFIG = {
  carpetaExtractos: '',   // ID de la carpeta de Drive con subcarpetas por año (2025, 2026…)
  anioActivo: String(new Date().getFullYear()),
  usuarios: '',           // emails permitidos separados por comas (vacío = cualquiera con la hoja compartida)
  umbralAmbar: '0.15',
  umbralRojo: '0.3',
  minimoDesviacion: '50'
};

// ------------------------------------------------------------------ arranque

/** Ejecutar una vez desde el editor (Ejecutar ▸ setup). Crea las pestañas y guarda el ID de la hoja. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Abre el editor desde la hoja (Extensiones ▸ Apps Script) para que el script quede vinculado.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SHEETS).forEach(function (name) { ensureSheet_(ss, name); });
  var cfg = readConfig_();
  var rows = [];
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { if (cfg[k] === undefined) rows.push([k, DEFAULT_CONFIG[k]]); });
  if (rows.length) {
    var sh = ss.getSheetByName('Config');
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
  }
  var def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  return 'Listo. Ahora: Implementar ▸ Nueva implementación ▸ Aplicación web.';
}

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var a = SpreadsheetApp.getActiveSpreadsheet();
  if (a) return a;
  throw new Error('Falta ejecutar setup() desde el editor de Apps Script.');
}

function ensureSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var hdr = SHEETS[name];
  var cur = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  // añade columnas nuevas al final sin tocar las existentes (migraciones suaves)
  var missing = hdr.filter(function (h) { return cur.indexOf(h) < 0; });
  if (!cur.length || (cur.length === 1 && cur[0] === '')) {
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (missing.length) {
    sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  // Todo como texto plano: evita que Sheets convierta ids hexadecimales ("1e5a…") en números
  // o fechas ISO en objetos Date. Los números se convierten al leer.
  sh.getRange(1, 1, sh.getMaxRows(), Math.max(hdr.length, sh.getLastColumn())).setNumberFormat('@');
  return sh;
}

// --------------------------------------------------------------- tablas

function readTable_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return [];
  var last = sh.getLastRow(), cols = sh.getLastColumn();
  if (last < 2) return [];
  var values = sh.getRange(1, 1, last, cols).getValues();
  var hdr = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var o = {};
    for (var c = 0; c < hdr.length; c++) {
      var v = row[c];
      if (v instanceof Date) v = FB.ymd(v);
      o[hdr[c]] = v;
    }
    out.push(o);
  }
  return out;
}

/** Reescribe la tabla completa (unas pocas miles de filas: es lo más simple y rápido). */
function writeTable_(name, objs) {
  var ss = ss_();
  var sh = ensureSheet_(ss, name);
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, hdr.length).clearContent();
  if (!objs.length) return;
  var rows = objs.map(function (o) {
    return hdr.map(function (h) { var v = o[h]; return v == null ? '' : v; });
  });
  sh.getRange(2, 1, rows.length, hdr.length).setValues(rows);
}

function readConfig_() {
  var cfg = {};
  readTable_('Config').forEach(function (r) { if (r.clave) cfg[r.clave] = String(r.valor); });
  return cfg;
}

function config_() {
  var c = readConfig_();
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { if (c[k] === undefined) c[k] = DEFAULT_CONFIG[k]; });
  return c;
}

function num_(v) { var n = Number(v); return isFinite(n) ? n : 0; }

function readMovs_() {
  return readTable_('Movimientos').map(function (m) {
    m.importe = num_(m.importe);
    m.saldo = m.saldo === '' || m.saldo == null ? null : num_(m.saldo);
    m.orden = num_(m.orden);
    m.confianza = m.confianza === '' ? '' : num_(m.confianza);
    m.fecha = String(m.fecha); m.fechaValor = String(m.fechaValor || '');
    return m;
  });
}

function readRules_() { return readTable_('Reglas'); }
function readPartidas_() { return readTable_('Partidas'); }
function readBudget_() {
  return readTable_('Presupuesto').map(function (b) { b.anio = num_(b.anio); b.mes = num_(b.mes); b.importe = num_(b.importe); return b; });
}

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

// --------------------------------------------------------------- web app

function doGet() {
  try { checkAccess_(); } catch (e) {
    return HtmlService.createHtmlOutput('<p style="font:16px system-ui;padding:24px">' + e.message + '</p>');
  }
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Presupuesto familiar')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

/** Todo lo que necesita el cliente para pintar. El cálculo se hace en el navegador con el mismo core. */
function apiBootstrap() {
  checkAccess_();
  var cfg = config_();
  var movs = readMovs_();
  return {
    usuario: user_(),
    config: cfg,
    partidas: readPartidas_(),
    presupuesto: readBudget_(),
    reglas: readRules_(),
    movimientos: movs,
    archivos: readTable_('Archivos')
  };
}

// ------------------------------------------------------ procesado de extractos

/**
 * Lee la carpeta de extractos (y sus subcarpetas de año), importa los ficheros
 * nuevos o modificados, deduplica por id, clasifica y guarda.
 */
function apiProcessFolder() {
  checkAccess_();
  return withLock_(function () { return processFolder_(); });
}

function processFolder_() {
  var cfg = config_();
  if (!cfg.carpetaExtractos) throw new Error('Configura la carpeta de extractos en Ajustes.');
  var root = DriveApp.getFolderById(extractId_(cfg.carpetaExtractos));
  var archivos = readTable_('Archivos');
  var known = {};
  archivos.forEach(function (a) { known[a.fileId] = a; });
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
      var grid = readGrid_(f.file);
      var parsed = FB.parseStatement(grid, f.file.getName());
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

  var c = FB.classifyAll(movs, readRules_(), readPartidas_());
  writeTable_('Movimientos', FB.chronoSort(c.movimientos).reverse());
  writeTable_('Archivos', Object.keys(known).map(function (k) { return known[k]; }));
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

/** Devuelve la primera hoja del fichero como rejilla de valores. Los .xls/.xlsx se convierten a una copia temporal. */
function readGrid_(file) {
  var mime = file.getMimeType();
  if (mime === 'text/csv') {
    var txt = file.getBlob().getDataAsString('ISO-8859-1');
    var sep = (txt.split('\n')[0].match(/;/g) || []).length > (txt.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
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
 * Asigna partida a uno o varios movimientos (marcados como manuales).
 * opts.regla = {patron, signo, min, max, meses} crea una regla y la reaplica a todo lo no manual.
 */
function apiClassify(ids, tipologia, opts) {
  checkAccess_();
  opts = opts || {};
  return withLock_(function () {
    var me = user_(), now = new Date().toISOString();
    var set = {};
    (ids || []).forEach(function (id) { set[id] = true; });
    var movs = readMovs_();
    movs.forEach(function (m) {
      if (!set[m.id]) return;
      m.tipologia = tipologia || '';
      m.estado = tipologia ? 'manual' : 'pendiente';
      if (opts.nota !== undefined) m.nota = opts.nota;
      m.modificado = now; m.autor = me;
    });
    var rules = readRules_();
    if (opts.regla && opts.regla.patron && tipologia) {
      rules.push({
        id: Utilities.getUuid().slice(0, 8), patron: String(opts.regla.patron).trim(), tipologia: tipologia,
        signo: opts.regla.signo || '', min: opts.regla.min || '', max: opts.regla.max || '', meses: opts.regla.meses || '',
        comentario: opts.regla.comentario || '', origen: 'app', creada: now, autor: me
      });
      writeTable_('Reglas', rules);
      // los marcados en esta acción pasan a depender de la regla (así un cambio de regla los arrastra)
      movs.forEach(function (m) { if (set[m.id] && m.estado === 'manual' && !opts.mantenerManual) m.estado = 'regla'; });
    }
    var c = FB.classifyAll(movs, rules, readPartidas_());
    writeTable_('Movimientos', FB.chronoSort(c.movimientos).reverse());
    return { stats: c.stats, movimientos: c.movimientos, reglas: rules };
  });
}

/** Acepta las propuestas indicadas tal cual (pasan a manuales). */
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
      m.tipologia = t; m.estado = 'manual'; m.modificado = now; m.autor = me;
    });
    var c = FB.classifyAll(movs, readRules_(), readPartidas_());
    writeTable_('Movimientos', FB.chronoSort(c.movimientos).reverse());
    return { stats: c.stats, movimientos: c.movimientos };
  });
}

function apiSetNote(id, nota) {
  checkAccess_();
  return withLock_(function () {
    var movs = readMovs_();
    movs.forEach(function (m) { if (m.id === id) { m.nota = nota; m.modificado = new Date().toISOString(); m.autor = user_(); } });
    writeTable_('Movimientos', movs);
    return true;
  });
}

/** Guarda la lista completa de reglas y reclasifica todo lo que no es manual. */
function apiSaveRules(rules) {
  checkAccess_();
  return withLock_(function () {
    var clean = (rules || []).filter(function (r) { return r.patron && r.tipologia; }).map(function (r) {
      return { id: r.id || Utilities.getUuid().slice(0, 8), patron: String(r.patron).trim(), tipologia: r.tipologia, signo: r.signo || '', min: r.min === 0 ? 0 : (r.min || ''), max: r.max === 0 ? 0 : (r.max || ''), meses: r.meses || '', comentario: r.comentario || '', origen: r.origen || 'app', creada: r.creada || new Date().toISOString(), autor: r.autor || user_() };
    });
    writeTable_('Reglas', clean);
    var c = FB.classifyAll(readMovs_(), clean, readPartidas_());
    writeTable_('Movimientos', FB.chronoSort(c.movimientos).reverse());
    return { stats: c.stats, movimientos: c.movimientos, reglas: clean };
  });
}

function apiSavePartidas(partidas) {
  checkAccess_();
  return withLock_(function () {
    var clean = (partidas || []).filter(function (p) { return p.tipologia; }).map(function (p, i) {
      return { tipologia: String(p.tipologia).trim(), bloque: String(p.bloque || 'OTROS').trim().toUpperCase(), tipo: FB.TIPOS.indexOf(p.tipo) >= 0 ? p.tipo : 'Gasto', orden: i + 1 };
    });
    writeTable_('Partidas', clean);
    return clean;
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
    writeTable_('Presupuesto', others.concat(mine));
    return readBudget_();
  });
}

function apiSaveConfig(values) {
  checkAccess_();
  return withLock_(function () {
    var cfg = config_();
    Object.keys(values || {}).forEach(function (k) { if (k in DEFAULT_CONFIG) cfg[k] = String(values[k]); });
    writeTable_('Config', Object.keys(cfg).map(function (k) { return { clave: k, valor: cfg[k] }; }));
    return cfg;
  });
}

/** Reclasifica todo desde cero (respetando lo manual). */
function apiReclassify() {
  checkAccess_();
  return withLock_(function () {
    var c = FB.classifyAll(readMovs_(), readRules_(), readPartidas_());
    writeTable_('Movimientos', FB.chronoSort(c.movimientos).reverse());
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
    var tmp = Drive.Files.create({ name: '[tmp] ' + file.getName(), mimeType: 'application/vnd.google-apps.spreadsheet' }, file.getBlob());
    var grids = {};
    try {
      var book = SpreadsheetApp.openById(tmp.id);
      ['Maestro_Tipologias', 'Reglas_Categorizacion', 'FC'].forEach(function (n) {
        var sh = book.getSheetByName(n);
        grids[n] = sh ? sh.getDataRange().getValues() : [];
      });
    } finally { Drive.Files.remove(tmp.id); }
    var data = FB.importFromBudgetWorkbook(grids, Number(anio));
    var replace = modo !== 'anadir';
    var partidas = replace ? [] : readPartidas_();
    var have = {}; partidas.forEach(function (p) { have[FB.norm(p.tipologia)] = true; });
    data.partidas.forEach(function (p) { if (!have[FB.norm(p.tipologia)]) { partidas.push(p); have[FB.norm(p.tipologia)] = true; } });
    partidas.forEach(function (p, i) { p.orden = i + 1; });
    writeTable_('Partidas', partidas);

    var rules = replace ? [] : readRules_();
    var haveR = {}; rules.forEach(function (r) { haveR[FB.norm(r.patron) + '|' + r.tipologia] = true; });
    var now = new Date().toISOString();
    data.reglas.forEach(function (r) {
      if (haveR[FB.norm(r.patron) + '|' + r.tipologia]) return;
      r.id = Utilities.getUuid().slice(0, 8); r.creada = now; r.autor = user_();
      rules.push(r);
    });
    writeTable_('Reglas', rules);

    var budget = readBudget_().filter(function (b) { return b.anio !== Number(anio); });
    writeTable_('Presupuesto', budget.concat(data.presupuesto));

    var c = FB.classifyAll(readMovs_(), rules, partidas);
    writeTable_('Movimientos', FB.chronoSort(c.movimientos).reverse());
    return { partidas: partidas.length, reglas: rules.length, presupuesto: data.presupuesto.length, stats: c.stats };
  });
}

// ----------------------------------------------------------------- disparador

/** Instala (una vez) el procesado diario de la carpeta. Se ejecuta con la cuenta de quien lo instala. */
function apiInstallDailyTrigger() {
  checkAccess_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyProcess') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyProcess').timeBased().everyDays(1).atHour(7).create();
  return 'Procesado diario activado (sobre las 7:00).';
}

function dailyProcess() {
  withLock_(function () { processFolder_(); });
}
