// Simulación mínima de Google Apps Script (SpreadsheetApp, DriveApp, Drive v3…) en memoria,
// para ejecutar src/server.js en Node. No reproduce todo: solo lo que usa la app.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function colToNum(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) { const v = (this.sheet.data[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined ? '' : v); }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error(`setValues: dimensiones ${vals.length}x${vals[0] && vals[0].length} vs rango ${this.nr}x${this.nc}`);
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v instanceof Date ? new Date(v.getTime()) : v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.r, this.c, v); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.set(this.r + i, this.c + j, ''); return this; }
}
['setNumberFormat', 'setFontWeight', 'setFontStyle', 'setFontColor', 'setBackground', 'setWrap'].forEach((m) => { FakeRange.prototype[m] = function () { return this; }; });

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
  set(r, c, v) { while (this.data.length < r) this.data.push([]); const row = this.data[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; if (r > this.maxRows) this.maxRows = r; }
  getName() { return this.name; }
  getLastRow() { for (let i = this.data.length; i > 0; i--) if ((this.data[i - 1] || []).some((v) => v !== '' && v != null)) return i; return 0; }
  getLastColumn() { let m = 0; this.data.forEach((r) => { for (let j = r.length; j > 0; j--) if (r[j - 1] !== '' && r[j - 1] != null) { m = Math.max(m, j); break; } }); return m; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const m = a.match(/^([A-Z]+)(\d+)?/); return new FakeRange(this, Number(m[2] || 1), colToNum(m[1]), 1, 1); }
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  getDataRange() { return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  clear() { this.data = []; return this; }
  setName(n) { this.name = n; return this; }
  setFrozenRows() {} setFrozenColumns() {} setColumnWidth() {}
}

class FakeSpreadsheet {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new FakeSheet('Hoja 1')]; }
  getId() { return this.id; } getName() { return this.name; } getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  toast() {}
}

/**
 * Crea un contexto con server.js cargado.
 * files: [{ id, name, folder, grid, mime }] — ficheros "en Drive" (grid = lo que daría la conversión a hoja).
 */
function loadServer(opts) {
  opts = opts || {};
  const book = new FakeSpreadsheet('SHEET1', 'Presupuesto familiar');
  const spreadsheets = { SHEET1: book };
  const files = opts.files || [];
  let tmpN = 0;
  const props = {};
  const createdFolders = new Set();
  const rootPath = opts.rootFolder ? opts.rootFolder.name : '';
  const allFolderPaths = () => {
    const set = new Set(createdFolders);
    files.forEach((f) => { if (!f.folder) return; const parts = f.folder.split('/'); for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/')); });
    if (rootPath) set.add(rootPath);
    return [...set];
  };
  const folderIdOf = (path) => (opts.rootFolder && path === rootPath ? opts.rootFolder.id : 'FOLDER:' + path);
  const fileObj = (f) => ({
    getId: () => f.id, getName: () => f.name, getMimeType: () => f.mime || 'application/vnd.ms-excel',
    getLastUpdated: () => new Date(f.modified || '2026-11-01T00:00:00Z'), getBlob: () => ({ __file: f }),
    getParents: () => { let done = !f.folder; return { hasNext: () => !done, next: () => { done = true; return folderObj(f.folder); } }; },
    moveTo: (folder) => { f.folder = folder.__path; },
    setTrashed: (v) => { f.trashed = !!v; }
  });
  // carpeta como en Drive: getName() es solo el último tramo de la ruta
  const folderObj = (path) => ({
    __path: path,
    getId: () => folderIdOf(path),
    getName: () => path.split('/').pop(),
    getFiles: () => { const list = files.filter((f) => f.folder === path); let i = 0; return { hasNext: () => i < list.length, next: () => fileObj(list[i++]) }; },
    getFolders: () => {
      const subs = allFolderPaths().filter((p) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/'));
      let i = 0; return { hasNext: () => i < subs.length, next: () => folderObj(subs[i++]) };
    },
    getParents: () => { const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null; let done = !parent; return { hasNext: () => !done, next: () => { done = true; return folderObj(parent); } }; },
    createFolder: (name) => { createdFolders.add(path + '/' + name); return folderObj(path + '/' + name); }
  });
  const folderByAnyId = (id) => {
    const p = allFolderPaths().find((x) => folderIdOf(x) === id);
    if (!p) throw new Error('Carpeta no encontrada ' + id);
    return folderObj(p);
  };
  const exported = [];
  const triggers = [];
  const mails = [];
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book, getActive: () => book,
      create: (name) => {
        const id = 'SS' + (++tmpN);
        const ss = new FakeSpreadsheet(id, name);
        spreadsheets[id] = ss;
        files.push({ id, name, folder: '', mime: 'application/vnd.google-apps.spreadsheet' });
        return ss;
      },
      openById: (id) => { if (!spreadsheets[id]) throw new Error('No existe ' + id); return spreadsheets[id]; },
      flush: () => {},
      getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => opts.user || 'ana@example.com' }), getScriptTimeZone: () => 'Europe/Madrid' },
    Utilities: {
      getUuid: () => 'u' + Math.random().toString(16).slice(2, 10) + 'xxxx',
      formatDate: (d) => d.toISOString(),
      parseCsv: (txt, sep) => txt.trim().split(/\r?\n/).map((l) => l.split(sep))
    },
    DriveApp: {
      getFolderById: (id) => folderByAnyId(id),
      getFileById: (id) => { const f = files.find((x) => x.id === id) || (id === 'SHEET1' ? { id, name: 'Presupuesto familiar', mime: 'application/vnd.google-apps.spreadsheet' } : null); if (!f) throw new Error('Fichero no encontrado ' + id); return fileObj(f); }
    },
    Drive: {
      Files: {
        create: (meta, blob) => {
          if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
            const id = 'tmp' + (++tmpN);
            const ss = new FakeSpreadsheet(id, meta.name);
            const f = blob.__file;
            if (f.sheets) { ss.sheets = Object.entries(f.sheets).map(([n, g]) => { const s = new FakeSheet(n); g.forEach((row, i) => row.forEach((v, j) => s.set(i + 1, j + 1, v))); return s; }); }
            else { const s = ss.sheets[0]; f.grid.forEach((row, i) => row.forEach((v, j) => s.set(i + 1, j + 1, v))); }
            spreadsheets[id] = ss;
            return { id };
          }
          const id = 'xlsx' + (++tmpN); exported.push({ id, meta }); return { id, name: meta.name };
        },
        update: (meta, id) => { exported.push({ id, update: true }); return { id, name: 'copia.xlsx' }; },
        remove: (id) => { delete spreadsheets[id]; }
      }
    },
    MailApp: { sendEmail: (o) => { mails.push(o); } },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getBlob: () => ({ setName() { return this; }, setContentType() { return this; } }) }) },
    ScriptApp: {
      getOAuthToken: () => 'tok',
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => {
        const t = { fn, kind: '', getHandlerFunction: () => fn };
        const b = { timeBased() { return b; }, everyDays() { t.kind = 'diario'; return b; }, onMonthDay(d) { t.kind = 'mensual-' + d; return b; }, atHour() { return b; }, create() { triggers.push(t); return t; } };
        return b;
      },
      getService: () => ({ getUrl: () => '' })
    },
    HtmlService: {}
  };
  vm.createContext(ctx);
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  vm.runInContext(src('core.js').replace('if (typeof module', 'if (false && typeof module'), ctx, { filename: 'core.js' });
  vm.runInContext(src('server.js'), ctx, { filename: 'server.js' });
  ctx.__triggers = triggers;
  ctx.__mails = mails;
  ctx.__book = book; ctx.__exported = exported; ctx.__files = files; ctx.__spreadsheets = spreadsheets;
  return ctx;
}

/** Lee una pestaña simulada como matriz. */
function grid(ctx, name) { const s = ctx.__book.getSheetByName(name); return s ? s.getDataRange().getValues() : null; }

module.exports = { loadServer, grid };
