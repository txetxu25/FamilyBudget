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

test('detectManualEdits: un cambio hecho a mano en la hoja se respeta como manual', () => {
  const rules = [{ patron: 'SUPER', tipologia: 'Supermercado' }];
  const first = FB.classifyAll([mov('2026-01-03', 'SUPER UNO', -30)], rules, PARTIDAS).movimientos;
  assert.equal(first[0].asignada, 'Supermercado');
  // alguien cambia la columna CLASIFICACION en la hoja
  const edited = [Object.assign({}, first[0], { tipologia: 'Ocio Familia' })];
  const again = FB.classifyAll(edited, rules, PARTIDAS).movimientos;
  assert.equal(again[0].estado, 'manual');
  assert.equal(again[0].tipologia, 'Ocio Familia');
  // si se cambia la regla (no el movimiento), el movimiento sigue a la regla
  const r2 = FB.classifyAll(first, [{ patron: 'SUPER', tipologia: 'Mercado' }], PARTIDAS.concat([{ tipologia: 'Mercado', bloque: 'DESPENSA', tipo: 'Gasto' }])).movimientos;
  assert.equal(r2[0].estado, 'regla');
  assert.equal(r2[0].tipologia, 'Mercado');
});

function monthly(t, from, to, amount, day) {
  const out = [];
  for (let m = from; m <= to; m++) out.push(mov('2026-' + String(m).padStart(2, '0') + '-' + (day || '10'), 'X' + t, amount, { tipologia: t }));
  return out;
}

test('forecast: tendencia ajusta el presupuesto restante al ritmo real', () => {
  const movs = monthly('Supermercado', 1, 9, -300);
  const presupuesto = []; for (let m = 1; m <= 12; m++) presupuesto.push({ anio: 2026, mes: m, tipologia: 'Supermercado', importe: m === 12 ? 400 : 200 });
  const f = FB.forecast({ year: 2026, partidas: PARTIDAS, movimientos: movs, presupuesto });
  const s = f.filas.find((x) => x.tipologia === 'Supermercado');
  assert.equal(f.hasta, 9);
  assert.equal(s.metodo, 'tendencia');
  assert.deepEqual(s.prevision.slice(9), [300, 300, 600], 'conserva la forma del presupuesto (diciembre más alto) × 1,5');
  assert.equal(s.cierre, 2700 + 1200);
});

test('forecast: un cobro extra aislado no dispara la tendencia', () => {
  const movs = monthly('Salario A', 1, 9, 2000).concat([mov('2026-09-15', 'EXTRA', 2000, { tipologia: 'Salario A' })]);
  const presupuesto = []; for (let m = 1; m <= 12; m++) presupuesto.push({ anio: 2026, mes: m, tipologia: 'Salario A', importe: 2000 });
  const s = FB.forecast({ year: 2026, partidas: PARTIDAS, movimientos: movs, presupuesto }).filas.find((x) => x.tipologia === 'Salario A');
  assert.deepEqual(s.prevision.slice(9), [2000, 2000, 2000]);
});

test('forecast: estacional usa el año anterior escalado', () => {
  const ly = [];
  for (let m = 1; m <= 12; m++) ly.push(mov('2025-' + String(m).padStart(2, '0') + '-10', 'GASCO', m >= 11 || m <= 2 ? -200 : -50, { tipologia: 'Luz' }));
  const cur = []; for (let m = 1; m <= 10; m++) cur.push(mov('2026-' + String(m).padStart(2, '0') + '-10', 'GASCO', m <= 2 ? -220 : -55, { tipologia: 'Luz' }));
  const s = FB.forecast({ year: 2026, partidas: PARTIDAS, movimientos: ly.concat(cur), presupuesto: [] }).filas.find((x) => x.tipologia === 'Luz');
  assert.equal(s.metodo, 'estacional');
  assert.deepEqual(s.prevision.slice(10), [220, 220], 'noviembre y diciembre caros como el año pasado, ×1,1');
});

test('forecast: lo esporádico asume el presupuesto y lo sin clasificar no se proyecta', () => {
  const movs = monthly('Supermercado', 1, 6, -100).concat([mov('2026-03-03', 'RARO', -80)]);
  const presupuesto = [{ anio: 2026, mes: 8, tipologia: 'Ocio Familia', importe: 900 }];
  const f = FB.forecast({ year: 2026, partidas: PARTIDAS, movimientos: movs, presupuesto });
  assert.equal(f.filas.find((x) => x.tipologia === 'Ocio Familia').cierre, 900);
  const sin = f.filas.find((x) => x.tipologia === FB.SIN_GASTO);
  assert.equal(sin.metodo, 'sin-proyeccion');
  assert.equal(sin.cierre, 80);
  assert.equal(f.totales.Gasto.cierre, 600 + 600 + 900 + 80);
});

test('reglas: espacios y puntuación no impiden la coincidencia en patrones largos', () => {
  const rules = FB.prepareRules([{ patron: 'GASCO ELECT. GAS', tipologia: 'Luz' }, { patron: 'VIA T', tipologia: 'Ocio Familia' }]);
  assert.equal(FB.matchRule({ concepto: 'GASCO ELECT.GAS', detalle: '', importe: -50, fecha: '2026-01-01' }, rules).rule.tipologia, 'Luz');
  assert.equal(FB.matchRule({ concepto: 'VIATGES SOL', detalle: '', importe: -50, fecha: '2026-01-01' }, rules).rule, null, 'un patrón corto no se compacta');
});

test('compareYears: real frente al mismo periodo del año anterior', () => {
  const movs = monthly('Supermercado', 1, 6, -100).concat(
    [1, 2, 3, 4, 5, 6].map((m) => mov('2025-0' + m + '-10', 'S', -80, { tipologia: 'Supermercado' })),
    [mov('2025-09-10', 'S', -500, { tipologia: 'Supermercado' })]);
  const c = FB.compareYears({ year: 2026, partidas: PARTIDAS, movimientos: movs });
  assert.equal(c.hasta, 6);
  const s = c.filas.find((f) => f.tipologia === 'Supermercado');
  assert.equal(s.actual, 600);
  assert.equal(s.anterior, 480, 'septiembre de 2025 queda fuera del periodo');
  assert.equal(c.totales.Gasto.dif, 120);
  assert.equal(FB.compareYears({ year: 2026, partidas: PARTIDAS, movimientos: monthly('Supermercado', 1, 6, -100) }), null, 'sin año anterior no hay comparación');
});

test('proposeBudget: fijos sin inflación, variables con inflación, estacionales con su reparto y ajustes', () => {
  const movs = []
    .concat(monthly('Supermercado', 1, 12, -300).map((m) => Object.assign(m, { fecha: m.fecha.replace('2026', '2025') })))
    .concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => mov('2025-' + String(m).padStart(2, '0') + '-01', 'PRESTAMO', -1000, { tipologia: 'Asignacion A' })))
    .concat([mov('2025-08-03', 'HOTEL MAR', -2000, { tipologia: 'Ocio Familia' })])
    .concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => mov('2025-' + String(m).padStart(2, '0') + '-05', 'LUZCO', m <= 2 || m >= 11 ? -200 : -50, { tipologia: 'Luz' })));
  // el supermercado varía un poco cada mes (no es "fijo")
  movs.filter((m) => m.tipologia === 'Supermercado').forEach((m, i) => { m.importe = -(280 + (i % 3) * 20); });
  const r = FB.proposeBudget({ year: 2026, partidas: PARTIDAS, movimientos: movs, presupuesto: [], inflacion: 0.1,
    ajustes: [{ concepto: 'Bebé', tipologia: 'Supermercado', desde: 3, hasta: 12, importe: 50 }] });
  assert.deepEqual(r.celdas['Asignacion A'], new Array(12).fill(1000), 'importe fijo: sin inflación');
  assert.equal(r.celdas.Supermercado[0], 330, 'mediana jul–dic (300) × 1,1');
  assert.equal(r.celdas.Supermercado[2], 380, '+50 del ajuste desde marzo');
  assert.equal(r.celdas.Luz[0], 220); assert.equal(r.celdas.Luz[5], 55, 'estacional: conserva el reparto');
  assert.equal(r.celdas['Ocio Familia'][7], 2200);
  assert.match(r.notas['Ocio Familia'], /HOTEL MAR: ¿se repetirá\?/);
  assert.match(r.comentarios['Supermercado|3'], /Bebé \+50/);
});

test('detectPriceIncreases: detecta la subida de una cuota y no confunde copagos ni consumos variables', () => {
  const movs = [];
  for (let m = 1; m <= 12; m++) {
    const f = '2025-' + String(m).padStart(2, '0');
    movs.push(mov(f + '-02', 'SEGURO SALUD SA', m >= 10 ? -205.98 : -183.33, { detalle: 'Recibo', tipologia: 'Luz' }));
    if (m % 3 === 0) movs.push(mov(f + '-02', 'SEGURO SALUD SA', -7, { detalle: 'Recibo' })); // copago
    movs.push(mov(f + '-05', 'LUZCO', -(60 + (m % 4) * 25), { detalle: 'Recibo' }));         // varía por consumo
    movs.push(mov(f + '-07', 'GIMNASIO', -40, { detalle: 'Recibo' }));                        // sin cambios
  }
  const r = FB.detectPriceIncreases(movs);
  assert.equal(r.length, 1, JSON.stringify(r.map((x) => x.comercio)));
  assert.equal(r[0].comercio, 'SEGURO SALUD SA');
  assert.equal(r[0].antes, 183.33);
  assert.equal(r[0].ahora, 205.98);
  assert.equal(r[0].desde, '2025-10-02');
  assert.ok(r[0].confirmada);
  assert.equal(r[0].impactoAnual, Math.round((205.98 - 183.33) * 12 * 100) / 100);
  // una subida que empezó hace más de 12 meses ya no se avisa
  assert.equal(FB.detectPriceIncreases(movs.concat([mov("2026-12-02", "OTRO", -1)])).length, 0);
  assert.equal(FB.detectPriceIncreases(movs, { meses: 1 }).length, 0);
});
