// Tests del núcleo con datos sintéticos. Nunca pongas aquí movimientos reales: el repo es público.
const test = require('node:test');
const assert = require('node:assert/strict');
const FB = require('../src/core.js');

const HEADER = ['Fecha', 'Fecha valor', 'Movimiento', 'Más datos', 'Importe', 'Saldo'];
const serial = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) / 86400000) + 25569);

// Extracto bancario típico: el más reciente primero.
function statement(rows) {
  return [
    ['Movimientos de la cuenta ES00 0000 0000 0000 0000 1234 (CCC: 0000)', '', '', '', '', ''],
    ['Importes expresados en euros', '', '', '', '', ''],
    HEADER
  ].concat(rows);
}

const PARTIDAS = [
  { tipologia: 'Salario A', bloque: 'INGRESOS', tipo: 'Ingreso' },
  { tipologia: 'Supermercado', bloque: 'DESPENSA', tipo: 'Gasto' },
  { tipologia: 'Panaderia', bloque: 'DESPENSA', tipo: 'Gasto' },
  { tipologia: 'Luz', bloque: 'SUMINISTROS', tipo: 'Gasto' },
  { tipologia: 'Ocio Familia', bloque: 'OCIO', tipo: 'Gasto' },
  { tipologia: 'Extra Nómina', bloque: 'INGRESOS', tipo: 'Ingreso' },
  { tipologia: 'Asignacion A', bloque: 'TRASPASOS', tipo: 'Traspaso' }
];

test('norm quita tildes y normaliza espacios', () => {
  assert.equal(FB.norm('  Asignación  Ana '), 'ASIGNACION ANA');
  assert.equal(FB.norm('Fecha de operación'), 'FECHA DE OPERACION');
});

test('toDate entiende serie Excel, dd/mm/yyyy y Date', () => {
  assert.equal(FB.ymd(FB.toDate(serial(2026, 10, 29))), '2026-10-29');
  assert.equal(FB.ymd(FB.toDate('05/03/2026')), '2026-03-05');
  assert.equal(FB.ymd(FB.toDate(new Date(2026, 0, 31, 23, 59))), '2026-01-31');
  assert.equal(FB.toDate('Fecha'), null);
});

test('parseAmount entiende formato español', () => {
  assert.equal(FB.parseAmount('-1.234,56'), -1234.56);
  assert.equal(FB.parseAmount(12.5), 12.5);
  assert.ok(isNaN(FB.parseAmount('')));
});

test('parseStatement lee el extracto y enmascara la cuenta', () => {
  const p = FB.parseStatement(statement([
    [serial(2026, 1, 30), serial(2026, 1, 30), 'SUPER UNO C/ MAYOR', 'Fecha de operación: 29-01-2026', -50, 950],
    [serial(2026, 1, 28), serial(2026, 1, 28), 'NOMINA', 'EMPRESA A SL', 1000, 1000]
  ]), 'enero.xls');
  assert.equal(p.cuenta, '····1234');
  assert.equal(p.movimientos.length, 2);
  assert.deepEqual(
    { f: p.movimientos[0].fecha, i: p.movimientos[0].importe, s: p.movimientos[0].saldo },
    { f: '2026-01-30', i: -50, s: 950 });
});

test('parseStatement falla con un mensaje claro si no hay cabecera', () => {
  assert.throws(() => FB.parseStatement([['hola']], 'x.xls'), /cabecera/);
});

test('movementId es estable y distingue compras idénticas por el saldo', () => {
  const a = { cuenta: 'x', fecha: '2026-01-01', fechaValor: '', concepto: 'BAR', detalle: '', importe: -2, saldo: 10 };
  const b = Object.assign({}, a, { saldo: 8 });
  assert.equal(FB.movementId(a), FB.movementId(Object.assign({}, a)));
  assert.notEqual(FB.movementId(a), FB.movementId(b));
});

test('checkBalance detecta un hueco entre extractos', () => {
  const ene = FB.parseStatement(statement([
    [serial(2026, 1, 31), serial(2026, 1, 31), 'BAR', '', -10, 990],
    [serial(2026, 1, 2), serial(2026, 1, 2), 'NOMINA', '', 1000, 1000]
  ]), 'ene.xls').movimientos;
  const feb = FB.parseStatement(statement([
    // falta un cargo de -100 entre medias: el saldo arranca en 890, no en 990
    [serial(2026, 2, 3), serial(2026, 2, 3), 'SUPER', '', -40, 850]
  ]), 'feb.xls').movimientos;
  const ok = FB.checkBalance(ene);
  assert.equal(ok.ok, true);
  const r = FB.checkBalance(ene.concat(feb));
  assert.equal(r.ok, false);
  assert.equal(r.roturas[0].fecha, '2026-02-03');
  assert.equal(r.roturas[0].diferencia, -100);
});

test('checkBalance tolera el orden de los movimientos dentro de un mismo día', () => {
  const movs = FB.parseStatement(statement([
    [serial(2026, 3, 2), serial(2026, 3, 2), 'B', '', -5, 85],
    [serial(2026, 3, 2), serial(2026, 3, 2), 'A', '', -10, 90],
    [serial(2026, 3, 1), serial(2026, 3, 1), 'INICIO', '', 100, 100]
  ]), 'm.xls').movimientos;
  assert.equal(FB.checkBalance(movs).ok, true);
});

test('matchRule: gana la regla más específica, no la primera', () => {
  const rules = FB.prepareRules([
    { patron: 'EMPRESA A', tipologia: 'Salario A' },
    { patron: 'TRANSF. A SU FAVOR EMPRESA A', tipologia: 'Extra Nómina' }
  ]);
  const m = { concepto: 'TRANSF. A SU FAVOR EMPRESA A', detalle: '', importe: 500, fecha: '2026-06-15' };
  assert.equal(FB.matchRule(m, rules).rule.tipologia, 'Extra Nómina');
});

test('matchRule: condiciones de mes e importe separan la paga extra del salario', () => {
  const rules = FB.prepareRules([
    { patron: 'NOMINA', tipologia: 'Salario A' },
    { patron: 'NOMINA', tipologia: 'Extra Nómina', meses: '6,12', min: 2500 }
  ]);
  const base = { concepto: 'NOMINA', detalle: 'EMPRESA A', fecha: '2026-06-28' };
  assert.equal(FB.matchRule(Object.assign({ importe: 2600 }, base), rules).rule.tipologia, 'Extra Nómina');
  assert.equal(FB.matchRule(Object.assign({ importe: 2200 }, base), rules).rule.tipologia, 'Salario A');
  assert.equal(FB.matchRule(Object.assign({}, base, { importe: 2600, fecha: '2026-05-28' }), rules).rule.tipologia, 'Salario A');
});

test('matchRule: las tildes no rompen una regla (ASIGNACIÓN vs ASIGNACION)', () => {
  const rules = FB.prepareRules([{ patron: 'ASIGNACION A', tipologia: 'Asignacion A' }]);
  assert.ok(FB.matchRule({ concepto: 'Asignación A octubre', detalle: '', importe: -300, fecha: '2026-10-01' }, rules).rule);
});

test('matchRule: avisa de conflicto cuando dos reglas empatan con distinta partida', () => {
  const rules = FB.prepareRules([
    { patron: 'LUZCO', tipologia: 'Luz' },
    { patron: 'MOVIL', tipologia: 'Ocio Familia' }
  ]);
  const r = FB.matchRule({ concepto: 'LUZCO MOVIL', detalle: '', importe: -20, fecha: '2026-01-01' }, rules);
  assert.equal(r.rule.tipologia, 'Luz');
  assert.equal(r.conflicto.length, 1);
});

function mov(fecha, concepto, importe, extra) {
  const m = Object.assign({ fecha, fechaValor: fecha, concepto, detalle: 'Fecha de operación: x', importe, saldo: null, cuenta: '', archivo: 'f', orden: 0 }, extra || {});
  m.id = FB.movementId(Object.assign({}, m, { saldo: Math.random() }));
  return m;
}

test('classifyAll: regla, propuesta aprendida y pendiente; respeta lo manual', () => {
  const movs = [
    mov('2026-01-03', 'SUPER UNO', -30), mov('2026-01-10', 'SUPER UNO', -40),
    mov('2026-01-12', 'HORNO PEPA', -3, { tipologia: 'Panaderia', estado: 'manual' }),
    mov('2026-02-12', 'HORNO PEPA', -4),
    mov('2026-02-20', 'COMERCIO RARO', -12),
    mov('2026-02-21', 'SUPER UNO', -10, { tipologia: 'Ocio Familia', estado: 'manual' })
  ];
  const c = FB.classifyAll(movs, [{ patron: 'SUPER UNO', tipologia: 'Supermercado' }], PARTIDAS);
  const by = c.movimientos;
  assert.equal(by[0].estado, 'regla');
  assert.equal(by[0].tipologia, 'Supermercado');
  assert.equal(by[2].estado, 'manual');
  assert.equal(by[3].estado, 'propuesta', 'mismo comercio que uno clasificado a mano');
  assert.equal(by[3].tipologia, 'Panaderia');
  assert.equal(by[4].estado, 'pendiente');
  assert.equal(by[5].tipologia, 'Ocio Familia', 'lo manual gana a la regla');
});

test('suggest no propone una partida de gasto para un ingreso', () => {
  const model = FB.buildSuggester([mov('2026-01-01', 'TIENDA X', -10, { tipologia: 'Supermercado', estado: 'regla' })]);
  const valid = {}; PARTIDAS.forEach(p => { valid[p.tipologia] = p; });
  assert.equal(FB.suggest(mov('2026-01-05', 'TIENDA X', 10), model, valid), null);
});

test('suggest usa pistas genéricas para comercios nunca vistos', () => {
  const valid = {}; PARTIDAS.forEach(p => { valid[p.tipologia] = p; });
  const s = FB.suggest(mov('2026-01-05', 'PANADERIA LA ESQUINA', -3), FB.buildSuggester([]), valid);
  assert.equal(s.tipologia, 'Panaderia');
  assert.ok(s.confianza < FB.UMBRAL_PROPUESTA, 'una pista genérica no cuenta sola en los totales');
});

test('summarize: signos, presupuesto, traspasos y semáforo', () => {
  const movs = [
    mov('2026-01-28', 'NOMINA', 2000, { tipologia: 'Salario A' }),
    mov('2026-01-05', 'SUPER', -300, { tipologia: 'Supermercado' }),
    mov('2026-01-06', 'SUPER', 20, { tipologia: 'Supermercado' }), // devolución
    mov('2026-01-07', 'ASIG', -500, { tipologia: 'Asignacion A' }),
    mov('2026-01-08', 'RARO', -50)
  ];
  const presupuesto = [
    { anio: 2026, mes: 1, tipologia: 'Salario A', importe: 2000 },
    { anio: 2026, mes: 1, tipologia: 'Supermercado', importe: 200 },
    { anio: 2026, mes: 2, tipologia: 'Supermercado', importe: 200 }
  ];
  const s = FB.summarize({ year: 2026, partidas: PARTIDAS, movimientos: movs, presupuesto });
  assert.equal(s.hasta, 1);
  const sup = s.filas.find(f => f.tipologia === 'Supermercado');
  assert.equal(sup.realYTD, 280);
  assert.equal(sup.pptoYTD, 200, 'solo hasta el último mes con datos');
  assert.equal(sup.pptoAnual, 400);
  assert.equal(sup.estado, 'alerta');
  assert.equal(s.filas.find(f => f.tipologia === FB.SIN_GASTO).realYTD, 50);
  assert.equal(s.neto.real[0], 2000 - 280 - 50 - 500);
});

test('status: para ingresos, quedarse corto es lo malo', () => {
  assert.equal(FB.status('Ingreso', 700, 1000), 'alerta');
  assert.equal(FB.status('Ingreso', 1300, 1000), 'ok');
  assert.equal(FB.status('Gasto', 1300, 1000), 'alerta');
  assert.equal(FB.status('Gasto', 1010, 1000), 'ok');
});

test('explainLine: detecta goteo de compras pequeñas y más frecuencia', () => {
  const movs = [];
  for (let m = 1; m <= 9; m++) for (let k = 0; k < 4; k++) movs.push(mov('2026-' + String(m).padStart(2, '0') + '-1' + k, 'HORNO ' + k, -10, { tipologia: 'Panaderia' }));
  for (let k = 0; k < 16; k++) movs.push(mov('2026-10-' + String(k + 10), 'HORNO ' + (k % 4), -10, { tipologia: 'Panaderia' }));
  const presupuesto = []; for (let m = 1; m <= 12; m++) presupuesto.push({ anio: 2026, mes: m, tipologia: 'Panaderia', importe: 40 });
  const e = FB.explainLine({ tipologia: 'Panaderia', year: 2026, desde: 10, hasta: 10, ultimoMes: 10, partidas: PARTIDAS, movimientos: movs, presupuesto });
  assert.equal(e.desv, 120);
  const tipos = e.causas.map(c => c.tipo);
  assert.ok(tipos.includes('frecuencia'), tipos.join());
  assert.ok(tipos.includes('goteo'), tipos.join());
});

test('explainLine: un cobro de más en una partida mensual se señala como extra', () => {
  const movs = [];
  for (let m = 1; m <= 6; m++) movs.push(mov('2026-' + String(m).padStart(2, '0') + '-28', 'NOMINA', 2000, { tipologia: 'Salario A', regla: 'NOMINA' }));
  movs.push(mov('2026-06-15', 'NOMINA', 2500, { tipologia: 'Salario A', regla: 'NOMINA' }));
  const presupuesto = []; for (let m = 1; m <= 6; m++) presupuesto.push({ anio: 2026, mes: m, tipologia: 'Salario A', importe: 2000 });
  const e = FB.explainLine({ tipologia: 'Salario A', year: 2026, desde: 1, hasta: 6, ultimoMes: 6, partidas: PARTIDAS, movimientos: movs, presupuesto });
  assert.equal(e.causas[0].tipo, 'extra');
  assert.match(e.causas[0].texto, /junio tiene 2/);
});

test('explainLine: un desfase de mes no se presenta como gasto extra', () => {
  const movs = [mov('2026-03-01', 'LUZCO', -300, { tipologia: 'Luz' })];
  const presupuesto = [{ anio: 2026, mes: 4, tipologia: 'Luz', importe: 300 }];
  const e = FB.explainLine({ tipologia: 'Luz', year: 2026, desde: 3, hasta: 3, ultimoMes: 4, partidas: PARTIDAS, movimientos: movs, presupuesto });
  assert.ok(e.causas.some(c => c.tipo === 'calendario'), JSON.stringify(e.causas));
});

test('topDeviations ordena por impacto en el ahorro', () => {
  const movs = [
    mov('2026-01-05', 'SUPER', -500, { tipologia: 'Supermercado' }),
    mov('2026-01-28', 'NOMINA', 1000, { tipologia: 'Salario A' })
  ];
  const presupuesto = [
    { anio: 2026, mes: 1, tipologia: 'Supermercado', importe: 400 },
    { anio: 2026, mes: 1, tipologia: 'Salario A', importe: 2000 }
  ];
  const top = FB.topDeviations({ year: 2026, partidas: PARTIDAS, movimientos: movs, presupuesto });
  assert.equal(top[0].tipologia, 'Salario A');
  assert.equal(top[0].impacto, 1000);
  assert.equal(top[1].impacto, 100);
});

test('importFromBudgetWorkbook convierte maestro, reglas y FC', () => {
  const grids = {
    Maestro_Tipologias: [
      ['MAESTRO DE TIPOLOGÍAS', null, null, null],
      ['Tipología', 'Clasificación (bloque)', 'Tipo', 'Naturaleza'],
      ['Salario A', 'INGRESOS', 'Ingreso', 'Ingreso'],
      ['Supermercado', 'DESPENSA', 'Gasto', 'Consumo'],
      ['Sin Clasificacion', 'SIN CLASIFICAR', 'Gasto', 'Pendiente de clasificar'],
      ['Asignacion A', 'TRASPASOS', 'Traspaso', 'Traspaso (no es consumo)'],
      [null, null, 'CONTROL DE INTEGRIDAD', null],
      ['=SUM(1)', null, 'Gastos reales', null]
    ],
    Reglas_Categorizacion: [
      ['Categoria_regla', 'Tipología', 'Clasificación', 'Comentario_defecto'],
      ['SUPER', 'Supermercado', 'DESPENSA', null],
      ['GIMNASIO', 'Gimnasio', 'OTROS GASTOS', 'nuevo']
    ],
    FC: [
      ['FECHA', 'TIPO ', 'IMPORTE REAL ', 'IMPORTE ESTIMADO', 'TIPOLOGÍA', 'CLASIFICACIÓN', 'COMENTARIO'],
      ['enero', 'Ingreso', null, 2000, 'Salario A', 'INGRESOS', null],
      ['enero', 'Gasto', null, 100, 'Supermercado', 'DESPENSA', 'semana 1'],
      ['enero', 'Gasto', null, 150, 'Supermercado', 'DESPENSA', 'semana 2'],
      ['febrero', 'Gasto', null, 0, 'Supermercado', 'DESPENSA', null]
    ]
  };
  const r = FB.importFromBudgetWorkbook(grids, 2026);
  assert.deepEqual(r.partidas.map(p => p.tipologia), ['Salario A', 'Supermercado', 'Asignacion A', 'Gimnasio']);
  assert.equal(r.partidas.find(p => p.tipologia === 'Asignacion A').tipo, 'Traspaso');
  assert.equal(r.reglas.length, 2);
  const sup = r.presupuesto.filter(b => b.tipologia === 'Supermercado');
  assert.equal(sup.length, 1);
  assert.equal(sup[0].importe, 250);
});
