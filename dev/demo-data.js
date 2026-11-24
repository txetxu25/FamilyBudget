// Datos de demostración 100% sintéticos (nombres y cifras inventados) para la vista previa y los tests de UI.
const FB = require('../src/core.js');

module.exports = function demo() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const partidas = [
    ['Nómina A', 'INGRESOS', 'Ingreso'], ['Nómina B', 'INGRESOS', 'Ingreso'], ['Paga extra', 'INGRESOS', 'Ingreso'], ['Otros ingresos', 'INGRESOS', 'Ingreso'],
    ['Hipoteca', 'VIVIENDA', 'Gasto'], ['Comunidad', 'VIVIENDA', 'Gasto'], ['IBI', 'VIVIENDA', 'Gasto'],
    ['Supermercado', 'DESPENSA', 'Gasto'], ['Mercado', 'DESPENSA', 'Gasto'], ['Panaderia', 'DESPENSA', 'Gasto'],
    ['Luz', 'SUMINISTROS', 'Gasto'], ['Gas', 'SUMINISTROS', 'Gasto'], ['Telefonía', 'SUMINISTROS', 'Gasto'],
    ['Colegio', 'EDUCACIÓN', 'Gasto'], ['Extraescolares', 'EDUCACIÓN', 'Gasto'],
    ['Ocio Familia', 'OCIO', 'Gasto'], ['Viaje', 'VIAJES', 'Gasto'], ['Coche', 'COCHES', 'Gasto'],
    ['Gastos Adicionales', 'OTROS GASTOS', 'Gasto'], ['Farmacia', 'OTROS GASTOS', 'Gasto'],
    ['Ahorro', 'TRASPASOS', 'Traspaso']
  ].map(([tipologia, bloque, tipo], i) => ({ tipologia, bloque, tipo, orden: i + 1 }));
  const reglas = [
    ['EMPRESA ALFA', 'Nómina A'], ['EMPRESA BETA', 'Nómina B'], ['PRESTAMO', 'Hipoteca'], ['COMUNIDAD PROP', 'Comunidad'],
    ['AYUNTAMIENTO', 'IBI'], ['SUPER', 'Supermercado'], ['FRUTAS', 'Mercado'], ['HORNO', 'Panaderia'], ['ELECTRICA', 'Luz'],
    ['GASES DEL NORTE', 'Gas'], ['TELCO', 'Telefonía'], ['COLEGIO', 'Colegio'], ['DEPORTES CLUB', 'Extraescolares'],
    ['CINE', 'Ocio Familia'], ['CAFETERIA', 'Ocio Familia'], ['FARMACIA', 'Farmacia'], ['TALLER', 'Coche'], ['TRASPASO AHORRO', 'Ahorro']
  ].map(([patron, tipologia], i) => ({ id: 'r' + i, patron, tipologia, signo: '', min: '', max: '', meses: '', comentario: '', origen: 'demo' }));
  const pres = [];
  const add = (t, mes, imp) => pres.push({ anio: 2026, mes, tipologia: t, importe: imp });
  for (let m = 1; m <= 12; m++) {
    add('Nómina A', m, 2300); add('Nómina B', m, 1800); add('Otros ingresos', m, 100);
    add('Hipoteca', m, 1300); add('Comunidad', m, 280); add('Supermercado', m, 520); add('Mercado', m, 180); add('Panaderia', m, 40);
    add('Luz', m, 110); add('Gas', m, m < 4 || m > 10 ? 160 : 60); add('Telefonía', m, 45); add('Ocio Familia', m, 150);
    add('Gastos Adicionales', m, 200); add('Farmacia', m, 30); add('Ahorro', m, 600);
    if (m !== 7 && m !== 8) { add('Colegio', m, 420); add('Extraescolares', m, 80); }
  }
  add('Paga extra', 6, 2300); add('Paga extra', 12, 2300); add('IBI', 1, 380); add('IBI', 7, 380);
  add('Viaje', 4, 700); add('Viaje', 8, 2500); add('Viaje', 12, 600); add('Coche', 3, 450); add('Coche', 10, 300);

  const movs = [];
  const put = (y, m, d, concepto, detalle, importe) => movs.push({ fecha: `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`, fechaValor: '', concepto, detalle, importe: FB.round2(importe), saldo: null, cuenta: '····0000', archivo: `demo_${m}.xls`, orden: movs.length });
  const shops = ['SUPER BARRIO', 'SUPER CENTRO'];
  const otros = ['LIBRERIA EL FARO', 'TIENDA DE ROPA SOL', 'BAZAR LUNA', 'FERRETERIA PEPE', 'ZAPATERIA PIES', 'JUGUETERIA OSO'];
  for (let m = 1; m <= 10; m++) {
    put(2026, m, 27, 'NOMINA', 'EMPRESA ALFA SL', 2300 + Math.round(rnd() * 40));
    put(2026, m, 28, 'NOMINA', 'EMPRESA BETA SA', 1800);
    if (m === 6) put(2026, m, 15, 'NOMINA', 'EMPRESA ALFA SL', 2350); // la paga extra entra con la regla de la nómina
    put(2026, m, 1, 'PRESTAMO 0001', 'Recibo', -1300);
    put(2026, m, 4, 'COMUNIDAD PROP', 'Recibo de fincas', -280);
    put(2026, m, 6, 'ELECTRICA VERDE', 'Recibo', -(95 + rnd() * 50));
    put(2026, m, 6, 'GASES DEL NORTE', 'Recibo', -(m < 4 || m > 9 ? 150 + rnd() * 60 : 50 + rnd() * 20));
    put(2026, m, 7, 'TELCO MOVIL', 'Recibo', -45);
    put(2026, m, 2, 'TRASPASO AHORRO', 'Cuenta ahorro', -600);
    if (m !== 7 && m !== 8) { put(2026, m, 5, 'COLEGIO SAN PEDRO', 'Recibo', -420); put(2026, m, 5, 'DEPORTES CLUB', 'Recibo', -80); }
    const weeks = m >= 9 ? 6 : 4; // en otoño se compra más a menudo
    for (let w = 0; w < weeks; w++) {
      put(2026, m, 3 + w * 5, shops[w % 2], 'Fecha de operación', -(90 + rnd() * 50));
      put(2026, m, 4 + w * 5, 'FRUTAS LA HUERTA', 'Fecha de operación', -(35 + rnd() * 15));
    }
    for (let k = 0; k < 6 + (m === 10 ? 10 : 0); k++) put(2026, m, 1 + k * 2, 'HORNO SAN JUAN', 'Fecha de operación', -(3 + rnd() * 4));
    put(2026, m, 12, 'CINE PLAZA', 'Fecha de operación', -38);
    put(2026, m, 19, 'CAFETERIA AURORA', 'Fecha de operación', -(15 + rnd() * 20));
    for (let k = 0; k < 4; k++) put(2026, m, 8 + k * 5, otros[(m + k) % otros.length], 'Fecha de operación', -(15 + rnd() * 45));
    if (rnd() > 0.5) put(2026, m, 21, 'FARMACIA CENTRAL', 'Fecha de operación', -(12 + rnd() * 30));
  }
  put(2026, 1, 15, 'AYUNTAMIENTO', 'IBI', -380); put(2026, 7, 15, 'AYUNTAMIENTO', 'IBI', -380);
  put(2026, 4, 10, 'HOTEL PLAYA AZUL', 'Fecha de operación', -640);
  put(2026, 8, 3, 'APARTAMENTOS COSTA', 'Fecha de operación', -2100);
  put(2026, 8, 5, 'RESTAURANTE EL PUERTO', 'Fecha de operación', -180);
  put(2026, 9, 14, 'TALLER MOTOR', 'Fecha de operación', -820);
  put(2026, 10, 9, 'BIZUM ENVIADO', 'Cumpleaños', -60);
  put(2026, 5, 20, 'TRANSFERENCIA', 'Devolución seguro', 230);

  // saldos coherentes (más reciente primero en el "extracto")
  let saldo = 12000;
  FB.chronoSort(movs).forEach((m) => { saldo = FB.round2(saldo + m.importe); m.saldo = saldo; });
  movs.forEach((m) => { m.id = FB.movementId(m); });
  const c = FB.classifyAll(movs, reglas, partidas);
  return { partidas, presupuesto: pres, reglas, movimientos: c.movimientos };
};
