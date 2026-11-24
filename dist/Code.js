// GENERADO por scripts/build.js desde src/. No editar a mano.
/**
 * FamilyBudget · núcleo de lógica compartido.
 *
 * Este fichero se ejecuta en dos sitios:
 *  - En Apps Script (servidor), como un .gs más: expone el global `FB`.
 *  - En el navegador (cliente), incrustado por el build en Core.html.
 * Y en Node para los tests (module.exports al final).
 *
 * No debe usar nada específico de Apps Script ni del DOM.
 */
var FB = (function () {
  'use strict';

  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  var TIPOS = ['Ingreso', 'Gasto', 'Traspaso'];
  var SIN_GASTO = '(Sin clasificar · gasto)';
  var SIN_INGRESO = '(Sin clasificar · ingreso)';

  // ---------------------------------------------------------------- utilidades

  /** Mayúsculas, sin tildes, espacios colapsados. Base de toda comparación de texto. */
  function norm(s) {
    return String(s == null ? '' : s)
      .toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/Ç/g, 'C')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Fecha como 'YYYY-MM-DD'. */
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  /**
   * Convierte a Date (hora local, mediodía para evitar saltos de zona):
   * Date, número de serie Excel, 'dd/mm/yyyy', 'dd-mm-yyyy' o 'yyyy-mm-dd'.
   */
  function toDate(v) {
    if (v == null || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return null;
      return new Date(v.getFullYear(), v.getMonth(), v.getDate(), 12);
    }
    if (typeof v === 'number' && isFinite(v)) {
      if (v < 20000 || v > 80000) return null; // fuera de 1954–2119: no es una fecha
      var ms = Math.round((v - 25569) * 86400000); // 25569 = 1970-01-01 en serie Excel
      var u = new Date(ms);
      return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 12);
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], 12);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12);
    return null;
  }

  /** '1.234,56' | '-12,30' | 12.3 -> número. */
  function parseAmount(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    var s = String(v).replace(/[€\s]/g, '');
    if (s === '') return NaN;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
    return Number(s);
  }

  /** Hash FNV-1a de 32 bits en hex: id estable de un movimiento. */
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function monthIndex(name) {
    var n = norm(name).toLowerCase();
    for (var i = 0; i < 12; i++) if (MESES[i] === n) return i + 1;
    var k = parseInt(n, 10);
    return k >= 1 && k <= 12 ? k : 0;
  }

  // --------------------------------------------------------- lectura extractos

  var HEADER_ALIASES = {
    fecha: ['FECHA', 'FECHA OPERACION', 'F. OPERACION'],
    fechaValor: ['FECHA VALOR', 'F. VALOR'],
    concepto: ['MOVIMIENTO', 'CONCEPTO', 'DESCRIPCION'],
    detalle: ['MAS DATOS', 'OBSERVACIONES', 'CONCEPTO AMPLIADO', 'DETALLE'],
    importe: ['IMPORTE', 'IMPORTE EUR', 'CANTIDAD'],
    saldo: ['SALDO', 'SALDO EUR', 'SALDO DISPONIBLE']
  };

  function findHeader(rows) {
    for (var r = 0; r < Math.min(rows.length, 30); r++) {
      var map = {};
      var row = rows[r] || [];
      for (var c = 0; c < row.length; c++) {
        var h = norm(row[c]);
        for (var key in HEADER_ALIASES) {
          if (map[key] === undefined && HEADER_ALIASES[key].indexOf(h) >= 0) map[key] = c;
        }
      }
      if (map.fecha !== undefined && map.importe !== undefined && map.concepto !== undefined) {
        return { row: r, cols: map };
      }
    }
    return null;
  }

  /**
   * Lee la rejilla de un extracto (filas x columnas, tal y como sale de una hoja).
   * Devuelve { cuenta, movimientos[] } con movimientos en el orden del fichero
   * (los bancos suelen poner el más reciente primero). `orden` es la posición en el fichero.
   */
  function parseStatement(rows, fileName) {
    var hdr = findHeader(rows);
    if (!hdr) throw new Error('No encuentro la cabecera (Fecha / Movimiento / Importe) en ' + (fileName || 'el extracto'));
    var cuenta = '';
    for (var r = 0; r < hdr.row; r++) {
      var m = norm((rows[r] || []).join(' ')).match(/ES\d{2}[\d ]{20,}/);
      if (m) { var digits = m[0].replace(/\D/g, ''); cuenta = '····' + digits.slice(-4); break; }
    }
    var c = hdr.cols;
    var out = [];
    for (var i = hdr.row + 1; i < rows.length; i++) {
      var row = rows[i] || [];
      var f = toDate(row[c.fecha]);
      var imp = parseAmount(row[c.importe]);
      if (!f || !isFinite(imp)) continue;
      var fv = c.fechaValor !== undefined ? toDate(row[c.fechaValor]) : null;
      var saldo = c.saldo !== undefined ? parseAmount(row[c.saldo]) : NaN;
      out.push({
        fecha: ymd(f),
        fechaValor: fv ? ymd(fv) : '',
        concepto: String(row[c.concepto] == null ? '' : row[c.concepto]).trim(),
        detalle: c.detalle !== undefined ? String(row[c.detalle] == null ? '' : row[c.detalle]).trim() : '',
        importe: round2(imp),
        saldo: isFinite(saldo) ? round2(saldo) : null,
        cuenta: cuenta,
        archivo: fileName || '',
        orden: i
      });
    }
    return { cuenta: cuenta, movimientos: out };
  }

  /**
   * Id estable. Incluye el saldo: dos compras idénticas el mismo día tienen
   * saldos distintos, así que no colisionan; y un extracto re-descargado que
   * solapa con otro produce los mismos ids (se deduplica solo).
   */
  function movementId(m) {
    // prefijo con letra: un id solo hexadecimal ("1e5…") lo convertiría Sheets en número
    return 'm' + hash([m.cuenta, m.fecha, m.fechaValor, norm(m.concepto), norm(m.detalle),
      round2(m.importe).toFixed(2), m.saldo == null ? '' : round2(m.saldo).toFixed(2)].join('|'));
  }

  /** Orden cronológico: fecha ascendente y, dentro del día, al revés que el fichero. */
  function chronoSort(movs) {
    return movs.slice().sort(function (a, b) {
      if (a.fecha !== b.fecha) return a.fecha < b.fecha ? -1 : 1;
      if (a.archivo !== b.archivo) return a.archivo < b.archivo ? -1 : 1;
      return b.orden - a.orden;
    });
  }

  /**
   * Comprueba la cadena de saldos: saldo(n) = saldo(n-1) + importe(n).
   * Una rotura significa que falta un extracto, hay un hueco o un duplicado.
   * Si dentro de un mismo día el banco ordena raro, se reintenta reordenando el día.
   */
  function checkBalance(movs) {
    var byAccount = {};
    movs.forEach(function (m) {
      if (m.saldo == null) return;
      (byAccount[m.cuenta || ''] = byAccount[m.cuenta || ''] || []).push(m);
    });
    var breaks = [];
    var checked = 0;
    Object.keys(byAccount).forEach(function (acc) {
      var list = chronoSort(byAccount[acc]);
      // agrupar por día para tolerar el orden intradía
      var days = [];
      list.forEach(function (m) {
        var d = days[days.length - 1];
        if (!d || d.fecha !== m.fecha) days.push(d = { fecha: m.fecha, items: [] });
        d.items.push(m);
      });
      var prev = null;
      days.forEach(function (d) {
        if (prev == null) { prev = d.items[d.items.length - 1].saldo; checked += d.items.length; return; }
        var sum = d.items.reduce(function (s, m) { return s + m.importe; }, 0);
        // el saldo final del día debe ser saldo previo + suma del día; y debe existir
        // un movimiento del día cuyo saldo sea ese final
        var expectedEnd = round2(prev + sum);
        var ends = d.items.map(function (m) { return m.saldo; });
        checked += d.items.length;
        if (ends.indexOf(expectedEnd) < 0) {
          var actualEnd = d.items[d.items.length - 1].saldo;
          // saldo real con el que empezó el día según el banco
          var first = d.items[0];
          var actualStart = round2(first.saldo - first.importe);
          breaks.push({
            cuenta: acc, fecha: d.fecha,
            saldoEsperado: round2(prev), saldoBanco: actualStart,
            diferencia: round2(actualStart - prev)
          });
          prev = actualEnd;
        } else {
          prev = expectedEnd;
        }
      });
    });
    return { ok: breaks.length === 0, revisados: checked, roturas: breaks };
  }

  // -------------------------------------------------------------- clasificación

  function matchText(m) { return norm((m.concepto || '') + ' ' + (m.detalle || '')); }

  /** Tipo de movimiento por signo. */
  function sentido(m) { return m.importe < 0 ? 'Gasto' : 'Ingreso'; }

  function parseMeses(v) {
    if (v == null || v === '') return [];
    return String(v).split(/[,;\s]+/).map(function (x) { return monthIndex(x); }).filter(Boolean);
  }

  /**
   * Reglas: { patron, tipologia, signo ('', 'Gasto', 'Ingreso'), min, max, meses, comentario }.
   * min/max sobre el importe en valor absoluto. meses: lista '6,12' o 'junio,diciembre'.
   */
  function prepareRules(rules) {
    return (rules || []).map(function (r, i) {
      var meses = Array.isArray(r.meses) ? r.meses : parseMeses(r.meses);
      var min = r.min === '' || r.min == null ? null : Number(r.min);
      var max = r.max === '' || r.max == null ? null : Number(r.max);
      var signo = r.signo === 'Gasto' || r.signo === 'Ingreso' ? r.signo : '';
      var p = norm(r.patron);
      var conds = (signo ? 1 : 0) + (min != null ? 1 : 0) + (max != null ? 1 : 0) + (meses.length ? 1 : 0);
      return {
        idx: i, id: r.id || String(i), patron: p, tipologia: r.tipologia, comentario: r.comentario || '',
        signo: signo, min: min, max: max, meses: meses,
        activa: r.activa !== false && r.activa !== 'NO' && p !== '' && !!r.tipologia,
        // Más específica = más condiciones, luego patrón más largo, luego orden en la lista.
        score: conds * 1000 + p.length
      };
    }).filter(function (r) { return r.activa; });
  }

  function ruleApplies(rule, m, text) {
    if (text.indexOf(rule.patron) < 0) return false;
    if (rule.signo && rule.signo !== sentido(m)) return false;
    var a = Math.abs(m.importe);
    if (rule.min != null && a < rule.min) return false;
    if (rule.max != null && a > rule.max) return false;
    if (rule.meses.length && rule.meses.indexOf(Number(m.fecha.slice(5, 7))) < 0) return false;
    return true;
  }

  /**
   * Devuelve { rule, conflicto } — rule es la coincidencia más específica.
   * conflicto lista otras reglas que también casan con otra tipología y empatan
   * en especificidad (esas son las peligrosas: decide el orden de la lista).
   */
  function matchRule(m, prepared) {
    var text = matchText(m);
    var hits = [];
    for (var i = 0; i < prepared.length; i++) if (ruleApplies(prepared[i], m, text)) hits.push(prepared[i]);
    if (!hits.length) return { rule: null, conflicto: [] };
    hits.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });
    var best = hits[0];
    var conflicto = hits.filter(function (h) {
      return h !== best && h.tipologia !== best.tipologia && h.score === best.score;
    });
    return { rule: best, conflicto: conflicto };
  }

  // Palabras que no identifican al comercio.
  var STOP = {};
  ('FECHA DE DEL LA EL LOS LAS Y EN POR PARA CON OPERACION RECIBO RECIBOS VARIOS SL S L SA SAU SLU ' +
    'C CL AV AVDA CALLE MADRID ESPANA ES TRF TRANSF TRANSFERENCIA FAVOR SU A COMPRA PAGO TARJETA ' +
    'CREDITO DEBITO CRED ENVIADO RECIBIDO NUM N NO').split(' ').forEach(function (w) { STOP[w] = 1; });

  function tokens(s) {
    return norm(s).split(/[^A-Z0-9]+/).filter(function (t) {
      return t.length >= 3 && !STOP[t] && !/^\d+$/.test(t);
    });
  }

  /** Clave de comercio para agrupar (insights) y proponer el patrón de una regla nueva. */
  function merchantKey(m) {
    var c = norm(m.concepto).replace(/\s*FECHA DE OPERACION.*$/, '');
    var generic = /^(NOMINA|NOMINA TRF|TRANSFERENCIA|TRANSF\.?|BIZUM|BIZUM ENVIADO|BIZUM RECIBIDO|RECIBO|TRASPASO|INGRESO|REINTEGRO|DEVOLUCION|ABONO|CARGO)\b/;
    var d = norm(m.detalle);
    if (generic.test(c) && d && !/^FECHA DE OPERACION/.test(d)) c = (c + ' ' + d).slice(0, 48);
    return c.replace(/[#*]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Patrón sugerido para una regla nueva a partir de un movimiento. */
  function suggestPattern(m) {
    var k = merchantKey(m);
    // quitar sufijos de sucursal típicos ("MERCADONA C/ ADEL" -> "MERCADONA")
    var t = k.split(' ');
    if (t.length > 1 && /^(C\/|C\.|CL|AV|AVDA|CTRA|PZA|MAD|S\.?L\.?|S\.?A\.?)/.test(t[1])) return t[0];
    return k.length > 24 ? t.slice(0, 2).join(' ') : k;
  }

  // Pistas genéricas para comercios nunca vistos. Solo se usan si la tipología existe.
  var HINTS = [
    [/HOTEL|PARADOR|APARTAMENTO|HOSTAL|AIRBNB|BOOKING|RENFE|SNCF|IBERIA|VUELING|RYANAIR|AIR EUROPA|BILLETE|TREN /, ['Viaje', 'Viaje Verano', 'Viaje Ocio']],
    [/BEACH CLUB|CHIRINGUITO|PUY DU FOU|TIQETS|PARQUE|MUSEO|ENTRADAS|CINE|TEATRO|ZOO|AQUOPOLIS|WARNER/, ['Ocio Familia', 'Viaje Ocio']],
    [/RESTAUR|BAR |CAFE|CAFETERIA|CHURR|PIZZ|BURGER|TABERNA|CERVECER|SUSHI|HELAD/, ['Ocio Familia', 'Gastos Adicionales']],
    [/FARMACIA|FCIA|PARAFARM|OPTICA|DENTAL|CLINICA/, ['Farmacia', 'Gastos Adicionales']],
    [/MERCADONA|LIDL|ALDI|CARREFOUR|AHORRAMAS|ALCAMPO|EROSKI|SUPERM|HIPERCOR|CONSUM|DIA /, ['Supermercado']],
    [/FRUTER|VERDUR|PESCAD|CARNIC|POLLER|MERCADO|HUERTA/, ['Mercado']],
    [/PANAD|HORNO|PASTEL|OBRADOR|BOLLER/, ['Panaderia']],
    [/ZAPAT|SHOES|KIABI|VERTBAUDET|OKAIDI|MAYORAL|BEBEPOLIS|PRENATAL|JUGUET|TOYS/, ['Compra Ropa Peques', 'Regalos peques', 'Gastos Adicionales']],
    [/OYSHO|ZARA|LEFTIES|PRIMARK|MANGO|BERSHKA|PULL|STRADIVARIUS|CORTEFIEL|SFERA|H&M|DECATHLON/, ['Gastos Adicionales']],
    [/LIBRO|LIBRER|BOOKS|PAPELER|FNAC|ESTANCO|PELUQ|TINTORER|BAZAR|VERDECORA|LEROY|IKEA/, ['Gastos Adicionales']],
    [/AMAZON|AMZN/, ['Compras Amazon', 'Gastos Adicionales']],
    [/MULTA|ITV|PARKING|APARCAM|GASOLIN|CEPSA|GALP|SHELL|TALLER/, ['Coche Volvo', 'Coche Polo']],
    [/NOMINA/, ['Salario*', 'Nomina*']],
    [/ASIGNACION|TRASPASO/, ['Asignacion*', 'Traspaso*', 'Ahorro*']]
  ];

  /** Resuelve el destino de una pista: nombre exacto o prefijo con '*'. */
  function hintTarget(name, validas, okTipo) {
    if (name.slice(-1) !== '*') return okTipo(name) ? name : null;
    var pre = norm(name.slice(0, -1));
    for (var t in validas) if (norm(t).indexOf(pre) === 0 && okTipo(t)) return t;
    return null;
  }

  /**
   * Modelo de propuesta: aprende de los movimientos ya clasificados (por regla o a mano).
   * Totalmente local: nada sale de Google.
   */
  function buildSuggester(movs) {
    var byMerchant = {}, byToken = {}, docs = 0, df = {};
    movs.forEach(function (m) {
      if (!m.tipologia || m.estado === 'pendiente' || m.estado === 'propuesta') return;
      var k = merchantKey(m) + '|' + sentido(m);
      (byMerchant[k] = byMerchant[k] || {})[m.tipologia] = (byMerchant[k][m.tipologia] || 0) + 1;
      var seen = {};
      tokens(m.concepto + ' ' + m.detalle).forEach(function (t) {
        var key = t + '|' + sentido(m);
        (byToken[key] = byToken[key] || {})[m.tipologia] = (byToken[key][m.tipologia] || 0) + 1;
        if (!seen[t]) { df[t] = (df[t] || 0) + 1; seen[t] = 1; }
      });
      docs++;
    });
    return { byMerchant: byMerchant, byToken: byToken, df: df, docs: docs };
  }

  function argmax(counts) {
    var best = null, bv = -1, total = 0;
    for (var k in counts) { total += counts[k]; if (counts[k] > bv) { bv = counts[k]; best = k; } }
    return { key: best, share: total ? bv / total : 0, total: total };
  }

  /**
   * Propone tipología para un movimiento sin regla.
   * validas: mapa tipologia -> {tipo}. Devuelve {tipologia, confianza (0–1), motivo} o null.
   */
  function suggest(m, model, validas) {
    var s = sentido(m);
    var okTipo = function (t) {
      var p = validas && validas[t];
      if (!p) return false;
      return p.tipo === 'Traspaso' || p.tipo === s; // un ingreso no va a una partida de gasto
    };
    // 1) mismo comercio ya visto
    var mk = model.byMerchant[merchantKey(m) + '|' + s];
    if (mk) {
      var am = argmax(mk);
      if (okTipo(am.key)) return { tipologia: am.key, confianza: Math.min(0.97, 0.6 + 0.37 * am.share), motivo: 'Mismo comercio clasificado antes (' + am.total + '×)' };
    }
    // 2) votación por palabras, ponderada por rareza (idf). La confianza baja si solo
    //    reconoce parte del concepto ("CASA DEL LIBRO" no es "CASADEMUNT") o si hay pocos ejemplos.
    var scores = {}, support = {}, matched = 0, totalIdf = 0;
    var maxIdf = Math.log(1 + Math.max(1, model.docs));
    var toks = tokens(m.concepto + ' ' + m.detalle);
    var uniq = {};
    toks.forEach(function (t) { uniq[t] = 1; });
    Object.keys(uniq).forEach(function (t) {
      var c = model.byToken[t + '|' + s];
      var idf = c ? Math.log(1 + model.docs / (model.df[t] || 1)) : maxIdf;
      totalIdf += idf;
      if (!c) return;
      matched += idf;
      var tot = 0; for (var k in c) tot += c[k];
      for (var k2 in c) {
        scores[k2] = (scores[k2] || 0) + idf * c[k2] / tot;
        support[k2] = (support[k2] || 0) + c[k2];
      }
    });
    var bestT = null, bestS = 0, second = 0;
    for (var t in scores) {
      if (!okTipo(t)) continue;
      if (scores[t] > bestS) { second = bestS; bestS = scores[t]; bestT = t; } else if (scores[t] > second) second = scores[t];
    }
    if (bestT && totalIdf > 0) {
      var coverage = matched / totalIdf;
      var purity = bestS / matched;
      var margin = (bestS - second) / bestS;
      var conf = coverage * purity * margin * Math.min(1, support[bestT] / 3);
      if (conf >= 0.3) return { tipologia: bestT, confianza: Math.min(0.9, conf), motivo: 'Palabras parecidas a movimientos de esa partida' };
    }
    // 3) pistas genéricas
    var text = matchText(m);
    for (var i = 0; i < HINTS.length; i++) {
      if (HINTS[i][0].test(text)) {
        for (var j = 0; j < HINTS[i][1].length; j++) {
          var tgt = hintTarget(HINTS[i][1][j], validas, okTipo);
          if (tgt) return { tipologia: tgt, confianza: 0.4, motivo: 'Tipo de comercio reconocido' };
        }
      }
    }
    return null;
  }

  var UMBRAL_PROPUESTA = 0.6; // por encima, la propuesta cuenta en los totales hasta que la revises

  /**
   * Clasifica una lista de movimientos. Respeta los manuales.
   * Devuelve la lista con tipologia/estado/regla/sugerencia actualizados + estadísticas.
   */
  function classifyAll(movs, rules, partidas) {
    var prepared = prepareRules(rules);
    var validas = {};
    (partidas || []).forEach(function (p) { validas[p.tipologia] = p; });
    var stats = { regla: 0, manual: 0, propuesta: 0, pendiente: 0, conflictos: 0 };
    var out = detectManualEdits(movs).map(function (m0) {
      var m = Object.assign({}, m0);
      if (m.estado === 'manual' && m.tipologia) { m.asignada = m.tipologia; stats.manual++; return m; }
      var r = matchRule(m, prepared);
      m.conflicto = r.conflicto.map(function (c) { return c.patron + ' → ' + c.tipologia; }).join('; ');
      if (m.conflicto) stats.conflictos++;
      if (r.rule) {
        m.tipologia = r.rule.tipologia; m.estado = 'regla'; m.regla = r.rule.patron;
        m.sugerencia = ''; m.confianza = '';
        stats.regla++;
      } else {
        m.tipologia = ''; m.estado = 'pendiente'; m.regla = ''; m.sugerencia = ''; m.confianza = '';
      }
      return m;
    });
    // segunda pasada: propuestas aprendidas de lo ya clasificado (incluye lo recién clasificado por regla)
    var model = buildSuggester(out);
    out.forEach(function (m) {
      if (m.estado !== 'pendiente') return;
      var s = suggest(m, model, validas);
      if (s) {
        m.sugerencia = s.tipologia; m.confianza = round2(s.confianza); m.motivo = s.motivo;
        if (s.confianza >= UMBRAL_PROPUESTA) { m.tipologia = s.tipologia; m.estado = 'propuesta'; stats.propuesta++; return; }
      }
      stats.pendiente++;
    });
    out.forEach(function (m) { m.asignada = m.tipologia || ''; });
    return { movimientos: out, stats: stats };
  }

  /**
   * Si alguien cambió la partida directamente en la hoja (columna CLASIFICACION),
   * ya no coincide con la que asignó la app (columna oculta "asignada"): se trata como manual.
   */
  function detectManualEdits(movs) {
    return movs.map(function (m) {
      if (m.estado === 'manual' || m.asignada === undefined) return m;
      var t = m.tipologia || '', a = m.asignada || '';
      if (t && t !== a) return Object.assign({}, m, { estado: 'manual' });
      return m;
    });
  }

  // --------------------------------------------------------------- agregación

  function partidaMap(partidas) {
    var map = {};
    (partidas || []).forEach(function (p) { map[p.tipologia] = p; });
    return map;
  }

  /**
   * Importe en "sentido de la partida": un gasto cuenta positivo en una partida de gasto,
   * una devolución lo resta. Igual para ingresos. Traspasos: salida positiva.
   */
  function signedForPartida(m, p) {
    if (!p) return m.importe < 0 ? -m.importe : m.importe;
    return p.tipo === 'Ingreso' ? m.importe : -m.importe;
  }

  function lineOf(m, pm) {
    if (m.tipologia && pm[m.tipologia]) return m.tipologia;
    return m.importe < 0 ? SIN_GASTO : SIN_INGRESO;
  }

  /**
   * Tabla real: { [tipologia]: [12 importes] } para un año.
   */
  function realByLine(movs, partidas, year) {
    var pm = partidaMap(partidas), out = {};
    movs.forEach(function (m) {
      if (Number(m.fecha.slice(0, 4)) !== Number(year)) return;
      var line = lineOf(m, pm);
      var mi = Number(m.fecha.slice(5, 7)) - 1;
      (out[line] = out[line] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])[mi] += signedForPartida(m, pm[line]);
    });
    for (var k in out) out[k] = out[k].map(round2);
    return out;
  }

  /** Presupuesto: filas {anio, mes, tipologia, importe} -> { [tipologia]: [12] }. */
  function budgetByLine(budget, year) {
    var out = {};
    (budget || []).forEach(function (b) {
      if (Number(b.anio) !== Number(year)) return;
      var mi = Number(b.mes) - 1;
      if (mi < 0 || mi > 11) return;
      (out[b.tipologia] = out[b.tipologia] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])[mi] += Number(b.importe) || 0;
    });
    for (var k in out) out[k] = out[k].map(round2);
    return out;
  }

  /** Último mes (1–12) con movimientos en el año; 0 si no hay. */
  function lastMonthWithData(movs, year) {
    var last = 0;
    movs.forEach(function (m) {
      if (Number(m.fecha.slice(0, 4)) === Number(year)) last = Math.max(last, Number(m.fecha.slice(5, 7)));
    });
    return last;
  }

  function sum(a, from, to) { var s = 0; for (var i = from; i <= to; i++) s += a[i] || 0; return s; }

  /**
   * Semáforo. Para gasto, pasarse es malo; para ingreso, quedarse corto es malo.
   * Devuelve 'ok' | 'aviso' | 'alerta' | 'sin-ppto'.
   */
  function status(tipo, real, ppto, umbrales) {
    var u = umbrales || { ambar: 0.15, rojo: 0.3, minimo: 50 };
    var desv = real - ppto;
    var malo = tipo === 'Ingreso' ? -desv : desv;
    if (Math.abs(desv) < (u.minimo || 0)) return 'ok';
    if (!ppto) return real ? 'sin-ppto' : 'ok';
    var pct = malo / Math.abs(ppto);
    if (pct >= u.rojo) return 'alerta';
    if (pct >= u.ambar) return 'aviso';
    return 'ok';
  }

  /**
   * Resumen del año hasta el mes `hasta` (incluido).
   * Devuelve filas por tipología y por bloque, totales mensuales y acumulados.
   */
  function summarize(opts) {
    var year = opts.year, partidas = opts.partidas || [], movs = opts.movimientos || [];
    var hasta = opts.hasta || lastMonthWithData(movs, year) || 12;
    var pm = partidaMap(partidas);
    var real = realByLine(movs, partidas, year);
    var ppto = budgetByLine(opts.presupuesto, year);
    var lines = {};
    partidas.forEach(function (p) { lines[p.tipologia] = true; });
    Object.keys(real).forEach(function (k) { lines[k] = true; });
    Object.keys(ppto).forEach(function (k) { lines[k] = true; });
    var Z = function () { return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; };
    var filas = Object.keys(lines).map(function (t) {
      var p = pm[t] || { tipologia: t, bloque: t === SIN_GASTO || t === SIN_INGRESO ? 'SIN CLASIFICAR' : 'SIN PARTIDA', tipo: t === SIN_INGRESO ? 'Ingreso' : 'Gasto' };
      var r = real[t] || Z(), b = ppto[t] || Z();
      var rY = round2(sum(r, 0, hasta - 1)), bY = round2(sum(b, 0, hasta - 1));
      return {
        tipologia: t, bloque: p.bloque, tipo: p.tipo,
        real: r, ppto: b, realYTD: rY, pptoYTD: bY, desvYTD: round2(rY - bY),
        pptoAnual: round2(sum(b, 0, 11)),
        estado: status(p.tipo, rY, bY, opts.umbrales)
      };
    }).filter(function (f) { return f.realYTD || f.pptoAnual || sum(f.real, 0, 11); });

    var bloques = {};
    filas.forEach(function (f) {
      var key = f.tipo + '|' + f.bloque;
      var b = bloques[key] = bloques[key] || { bloque: f.bloque, tipo: f.tipo, real: Z(), ppto: Z(), lineas: [] };
      for (var i = 0; i < 12; i++) { b.real[i] += f.real[i]; b.ppto[i] += f.ppto[i]; }
      b.lineas.push(f.tipologia);
    });
    var listaBloques = Object.keys(bloques).map(function (k) {
      var b = bloques[k];
      b.real = b.real.map(round2); b.ppto = b.ppto.map(round2);
      b.realYTD = round2(sum(b.real, 0, hasta - 1)); b.pptoYTD = round2(sum(b.ppto, 0, hasta - 1));
      b.desvYTD = round2(b.realYTD - b.pptoYTD);
      b.estado = status(b.tipo, b.realYTD, b.pptoYTD, opts.umbrales);
      return b;
    });

    var tot = {};
    TIPOS.forEach(function (tp) { tot[tp] = { real: Z(), ppto: Z() }; });
    filas.forEach(function (f) {
      var T = tot[f.tipo] || tot.Gasto;
      for (var i = 0; i < 12; i++) { T.real[i] += f.real[i]; T.ppto[i] += f.ppto[i]; }
    });
    var neto = { real: Z(), ppto: Z() };
    for (var i = 0; i < 12; i++) {
      neto.real[i] = round2(tot.Ingreso.real[i] - tot.Gasto.real[i] - tot.Traspaso.real[i]);
      neto.ppto[i] = round2(tot.Ingreso.ppto[i] - tot.Gasto.ppto[i] - tot.Traspaso.ppto[i]);
    }
    TIPOS.forEach(function (tp) { tot[tp].real = tot[tp].real.map(round2); tot[tp].ppto = tot[tp].ppto.map(round2); });

    var clasif = { total: 0, regla: 0, manual: 0, propuesta: 0, pendiente: 0 };
    movs.forEach(function (m) {
      if (Number(m.fecha.slice(0, 4)) !== Number(year)) return;
      clasif.total++; clasif[m.estado || 'pendiente'] = (clasif[m.estado || 'pendiente'] || 0) + 1;
    });

    return { year: year, hasta: hasta, filas: filas, bloques: listaBloques, totales: tot, neto: neto, clasificacion: clasif };
  }

  // ---------------------------------------------------------------- previsión

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  /**
   * Extrapola cada partida hasta diciembre a partir de lo ya ocurrido.
   * Métodos (por partida, el primero que aplique):
   *  - 'estacional': hay ≥6 meses del año anterior → mes del año pasado × (ritmo de este año / ritmo del pasado).
   *  - 'tendencia' : la partida se mueve casi todos los meses → presupuesto restante × (real / presupuesto de los
   *                  últimos 3 meses); si no hay presupuesto, la mediana de los últimos 3 meses.
   *  - 'presupuesto': gasto esporádico → lo que queda presupuestado.
   * Las proporciones se acotan entre 0,5× y 2× para que un mes raro no dispare la previsión.
   */
  function forecast(opts) {
    var s = summarize(opts);
    var hasta = s.hasta;
    var prev = realByLine(opts.movimientos || [], opts.partidas || [], Number(opts.year) - 1);
    var Z = function () { return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; };
    var filas = s.filas.map(function (f) {
      var real = f.real, ppto = f.ppto, ly = prev[f.tipologia];
      var rY = sum(real, 0, hasta - 1);
      var activos = 0;
      for (var i = 0; i < hasta; i++) if (Math.abs(real[i]) > 0.005) activos++;
      var lyActivos = 0;
      if (ly) for (var j = 0; j < 12; j++) if (Math.abs(ly[j]) > 0.005) lyActivos++;
      var lyYTD = ly ? sum(ly, 0, hasta - 1) : 0;
      var fc = Z(), metodo, detalle = '';
      if (f.tipologia === SIN_GASTO || f.tipologia === SIN_INGRESO) {
        // no se proyecta: lo que hoy está sin clasificar acabará en otras partidas, que ya tienen su previsión
        metodo = 'sin-proyeccion'; detalle = 'No se proyecta: clasifica estos movimientos para afinar la previsión';
      } else if (ly && lyActivos >= 6 && lyYTD > 0 && rY > 0) {
        var ratio = clamp(rY / lyYTD, 0.5, 2);
        for (var a = hasta; a < 12; a++) fc[a] = ly[a] * ratio;
        metodo = 'estacional';
        detalle = 'Mismos meses de ' + (Number(opts.year) - 1) + ' × ' + (Math.round(ratio * 100) / 100).toString().replace('.', ',');
      } else if (hasta >= 3 && activos >= Math.max(3, 0.6 * hasta)) {
        var desde3 = Math.max(0, hasta - 3);
        var pRest = sum(ppto, hasta, 11);
        var ratios = [];
        for (var q = desde3; q < hasta; q++) if (ppto[q] > 0) ratios.push(real[q] / ppto[q]);
        if (ratios.length >= 2 && pRest > 0) {
          // mediana de real/presupuesto mes a mes: un cobro extra aislado no mueve la previsión
          var k = clamp(median(ratios), 0.5, 2);
          for (var b = hasta; b < 12; b++) fc[b] = ppto[b] * k;
          detalle = 'Presupuesto restante × ' + (Math.round(k * 100) / 100).toString().replace('.', ',') + ' (ritmo de los últimos 3 meses)';
        } else {
          var med = median(real.slice(desde3, hasta));
          for (var c = hasta; c < 12; c++) fc[c] = med;
          detalle = 'Mediana de los últimos 3 meses (' + fmt(med) + '/mes)';
        }
        metodo = 'tendencia';
      } else {
        for (var d = hasta; d < 12; d++) fc[d] = ppto[d];
        metodo = 'presupuesto';
        detalle = 'Partida esporádica: se asume lo que queda presupuestado';
      }
      fc = fc.map(round2);
      var cierre = round2(rY + sum(fc, hasta, 11));
      var serie = real.map(function (v, i) { return i < hasta ? v : fc[i]; });
      return {
        tipologia: f.tipologia, tipo: f.tipo, bloque: f.bloque, real: real, ppto: ppto, prevision: fc, serie: serie,
        metodo: metodo, detalle: detalle, realYTD: round2(rY), cierre: cierre, pptoAnual: f.pptoAnual,
        desvCierre: round2(cierre - f.pptoAnual), estadoCierre: status(f.tipo, cierre, f.pptoAnual, opts.umbrales)
      };
    });
    var tot = {};
    TIPOS.forEach(function (t) { tot[t] = { serie: Z(), ppto: Z(), cierre: 0, pptoAnual: 0 }; });
    filas.forEach(function (f) {
      var T = tot[f.tipo] || tot.Gasto;
      for (var i = 0; i < 12; i++) { T.serie[i] += f.serie[i]; T.ppto[i] += f.ppto[i]; }
      T.cierre += f.cierre; T.pptoAnual += f.pptoAnual;
    });
    TIPOS.forEach(function (t) { tot[t].serie = tot[t].serie.map(round2); tot[t].ppto = tot[t].ppto.map(round2); tot[t].cierre = round2(tot[t].cierre); tot[t].pptoAnual = round2(tot[t].pptoAnual); });
    var neto = { serie: Z(), ppto: Z() };
    for (var n = 0; n < 12; n++) {
      neto.serie[n] = round2(tot.Ingreso.serie[n] - tot.Gasto.serie[n] - tot.Traspaso.serie[n]);
      neto.ppto[n] = round2(tot.Ingreso.ppto[n] - tot.Gasto.ppto[n] - tot.Traspaso.ppto[n]);
    }
    neto.cierre = round2(sum(neto.serie, 0, 11)); neto.pptoAnual = round2(sum(neto.ppto, 0, 11));
    // partidas que más mueven el cierre respecto al presupuesto anual (impacto en el ahorro)
    var palancas = filas.map(function (f) { return { tipologia: f.tipologia, tipo: f.tipo, desvCierre: f.desvCierre, impacto: f.tipo === 'Ingreso' ? -f.desvCierre : f.desvCierre, metodo: f.metodo }; })
      .filter(function (p) { return Math.abs(p.desvCierre) >= 50; })
      .sort(function (a, b) { return Math.abs(b.impacto) - Math.abs(a.impacto); });
    return { year: s.year, hasta: hasta, filas: filas, totales: tot, neto: neto, palancas: palancas };
  }

  // ----------------------------------------------------------------- insights

  function fmt(x) {
    var v = Math.round(Math.abs(x));
    var s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (x < 0 ? '−' : '') + s + ' €';
  }
  function fmtSigned(x) { return (x > 0 ? '+' : x < 0 ? '−' : '') + fmt(Math.abs(x)); }

  function x0(extras) { return extras.length ? extras[0].m : {}; }

  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var h = Math.floor(s.length / 2);
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  /**
   * Explica la desviación de una partida en un periodo [desde, hasta] (meses 1–12).
   * Compara contra el presupuesto y busca: compras puntuales grandes, más frecuencia,
   * ticket más caro (vs. el resto del año o el año anterior), comercios nuevos,
   * y desfases de calendario (el presupuesto estaba en otro mes).
   */
  function explainLine(opts) {
    var t = opts.tipologia, year = Number(opts.year), desde = opts.desde, hasta = opts.hasta;
    var pm = partidaMap(opts.partidas);
    var p = pm[t] || { tipo: t === SIN_INGRESO ? 'Ingreso' : 'Gasto' };
    var inLine = function (m) { return lineOf(m, pm) === t; };
    var mon = function (m) { return Number(m.fecha.slice(5, 7)); };
    var yr = function (m) { return Number(m.fecha.slice(0, 4)); };
    var all = (opts.movimientos || []).filter(inLine);
    var cur = all.filter(function (m) { return yr(m) === year && mon(m) >= desde && mon(m) <= hasta; });
    var val = function (m) { return signedForPartida(m, pm[t]); };
    var real = round2(cur.reduce(function (s, m) { return s + val(m); }, 0));
    var bl = budgetByLine(opts.presupuesto, year)[t] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var ppto = round2(sum(bl, desde - 1, hasta - 1));
    var desv = round2(real - ppto);
    var nMeses = hasta - desde + 1;
    var causas = [];

    // referencia para frecuencia/ticket: mismo periodo del año anterior; si no hay, el resto del año en curso
    var base = all.filter(function (m) { return yr(m) === year - 1 && mon(m) >= desde && mon(m) <= hasta; });
    var baseLabel = 'el mismo periodo de ' + (year - 1), baseMeses = nMeses;
    if (base.length < 3) {
      base = all.filter(function (m) { return yr(m) === year && (mon(m) < desde || mon(m) > hasta) && mon(m) <= (opts.ultimoMes || 12); });
      var mesesBase = {};
      base.forEach(function (m) { mesesBase[mon(m)] = 1; });
      baseMeses = Object.keys(mesesBase).length;
      baseLabel = 'tu media del resto del año';
    }

    var esBolsa = t === SIN_GASTO || t === SIN_INGRESO;

    // 0) partida recurrente (≈1 movimiento al mes): ¿hay meses con movimientos de más?
    var porMes = {};
    all.filter(function (m) { return yr(m) === year && mon(m) <= (opts.ultimoMes || hasta); })
      .forEach(function (m) { (porMes[mon(m)] = porMes[mon(m)] || []).push(m); });
    var mesesConDatos = Object.keys(porMes);
    var unoAlMes = mesesConDatos.filter(function (k) { return porMes[k].length === 1; }).length;
    // recurrente = aparece casi todos los meses (≥60% de los meses transcurridos) y casi siempre una vez
    var recurrente = !esBolsa && mesesConDatos.length >= Math.max(3, 0.6 * (opts.ultimoMes || hasta)) &&
      unoAlMes >= 0.6 * mesesConDatos.length;
    if (recurrente) {
      var extras = [];
      for (var mm = desde; mm <= hasta; mm++) {
        var lista = porMes[mm] || [];
        if (lista.length > 1) {
          var orden = lista.slice().sort(function (a, b) { return Math.abs(val(b)) - Math.abs(val(a)); });
          extras = extras.concat(orden.slice(1).map(function (m) { return { m: m, mes: mm }; }));
        }
      }
      if (extras.length) {
        var se = extras.reduce(function (s, x) { return s + val(x.m); }, 0);
        causas.push({
          tipo: 'extra', peso: Math.abs(se) * 1.2,
          texto: 'Partida mensual con movimientos de más: ' + extras.map(function (x) { return MESES[x.mes - 1] + ' tiene ' + porMes[x.mes].length + ' (' + merchantKey(x.m) + ', ' + fmt(val(x.m)) + ')'; }).join('; ') +
            '. Si es una paga extra, un recibo duplicado o un cargo de otra partida, revisa la regla «' + (x0(extras).regla || '—') + '».',
          movimientos: extras.map(function (x) { return x.m.id; })
        });
      }
    }

    // 1) cargos puntuales grandes (no en partidas recurrentes: ahí todos los cargos son "grandes")
    var vals = cur.map(val).filter(function (v) { return v > 0; });
    var med = median(vals);
    var grandes = recurrente ? [] : cur.filter(function (m) {
      var v = val(m);
      return v > 0 && vals.length >= 1 && (v >= Math.max(3 * med, 150) || (Math.abs(desv) > 0 && v >= 0.4 * Math.abs(desv) && v >= 100));
    }).sort(function (a, b) { return val(b) - val(a); }).slice(0, 3);
    if (grandes.length && desv > 0) {
      var sg = grandes.reduce(function (s, m) { return s + val(m); }, 0);
      causas.push({
        tipo: 'puntual', peso: sg,
        texto: (grandes.length === 1 ? 'Un cargo puntual explica ' : grandes.length + ' cargos puntuales explican ') + fmt(sg) +
          ': ' + grandes.map(function (m) { return merchantKey(m) + ' (' + fmt(val(m)) + ', ' + m.fecha.slice(8, 10) + '/' + m.fecha.slice(5, 7) + ')'; }).join(', ') + '.',
        movimientos: grandes.map(function (m) { return m.id; })
      });
    }

    // 2) frecuencia vs ticket medio (solo con base suficiente)
    if (!esBolsa && !recurrente && base.length >= 3 && baseMeses > 0 && cur.length >= 2) {
      var n1 = cur.length / nMeses, n0 = base.length / baseMeses;
      var t1 = real / cur.length;
      var t0 = base.reduce(function (s, m) { return s + val(m); }, 0) / base.length;
      var efFrecuencia = (n1 - n0) * t0 * nMeses;
      var efTicket = (t1 - t0) * n1 * nMeses;
      if (Math.abs(efFrecuencia) >= 40 && Math.abs(efFrecuencia) >= Math.abs(efTicket)) {
        var ticketParecido = Math.abs(t1 - t0) <= 0.15 * Math.abs(t0);
        causas.push({
          tipo: 'frecuencia', peso: Math.abs(efFrecuencia),
          texto: (efFrecuencia > 0 ? 'Más' : 'Menos') + ' compras de lo habitual: ' + (Math.round(n1 * 10) / 10) + '/mes frente a ' +
            (Math.round(n0 * 10) / 10) + '/mes en ' + baseLabel + ' (' + fmtSigned(efFrecuencia) + '). ' +
            (ticketParecido ? 'El ticket medio apenas cambia (' : 'El ticket medio también cambia (') + fmt(t1) + ' vs ' + fmt(t0) + ').'
        });
      } else if (Math.abs(efTicket) >= 40) {
        causas.push({
          tipo: 'ticket', peso: Math.abs(efTicket),
          texto: 'Ticket medio ' + (efTicket > 0 ? 'más alto' : 'más bajo') + ': ' + fmt(t1) + ' por compra frente a ' + fmt(t0) + ' en ' + baseLabel +
            ' (' + fmtSigned(efTicket) + '), con una frecuencia similar.'
        });
      }
    }

    // 3) concentración por comercio y comercios nuevos
    var porComercio = {};
    cur.forEach(function (m) {
      var k = merchantKey(m);
      var c = porComercio[k] = porComercio[k] || { comercio: k, importe: 0, n: 0 };
      c.importe += val(m); c.n++;
    });
    var antes = {};
    all.forEach(function (m) { if (yr(m) < year || (yr(m) === year && mon(m) < desde)) antes[merchantKey(m)] = 1; });
    var hayHistoria = Object.keys(antes).length > 0;
    var comercios = Object.keys(porComercio).map(function (k) { porComercio[k].importe = round2(porComercio[k].importe); porComercio[k].nuevo = hayHistoria && !antes[k]; return porComercio[k]; })
      .sort(function (a, b) { return b.importe - a.importe; });
    var nuevos = comercios.filter(function (c) { return c.nuevo && c.importe > 0; });
    var sn = nuevos.reduce(function (s, c) { return s + c.importe; }, 0);
    if (!recurrente && desv > 0 && nuevos.length && sn >= Math.max(60, 0.25 * desv) && Object.keys(antes).length) {
      causas.push({
        tipo: 'nuevos', peso: sn,
        texto: nuevos.length + ' comercio' + (nuevos.length > 1 ? 's' : '') + ' nuevo' + (nuevos.length > 1 ? 's' : '') + ' suman ' + fmt(sn) + ': ' +
          nuevos.slice(0, 4).map(function (c) { return c.comercio + ' (' + fmt(c.importe) + ')'; }).join(', ') + (nuevos.length > 4 ? '…' : '') + '.'
      });
    }
    // goteo: muchas compras pequeñas
    var pequenas = cur.filter(function (m) { var v = val(m); return v > 0 && v < 40; });
    var sp = pequenas.reduce(function (s, m) { return s + val(m); }, 0);
    if (desv > 0 && pequenas.length >= 8 && sp >= 0.4 * real) {
      causas.push({
        tipo: 'goteo', peso: sp * 0.8,
        texto: 'Goteo: ' + pequenas.length + ' compras de menos de 40 € suman ' + fmt(sp) + ' (' + Math.round(100 * sp / real) + '% de lo gastado en la partida).'
      });
    }

    // 4) desfase de calendario
    if (nMeses < 12) {
      var anual = sum(bl, 0, 11);
      var pptoHastaFin = sum(bl, 0, (opts.ultimoMes || hasta) - 1);
      var realHastaFin = round2(all.filter(function (m) { return yr(m) === year && mon(m) <= (opts.ultimoMes || hasta); })
        .reduce(function (s, m) { return s + val(m); }, 0));
      var desvAcum = realHastaFin - pptoHastaFin;
      if (Math.abs(desv) >= 100 && Math.abs(desvAcum) < 0.35 * Math.abs(desv)) {
        causas.push({
          tipo: 'calendario', peso: Math.abs(desv) - Math.abs(desvAcum),
          texto: 'Desfase de calendario: en el acumulado del año la partida va ' + fmtSigned(desvAcum) + ', así que la desviación de este periodo es sobre todo un cambio de mes, no un gasto extra.'
        });
      } else if (ppto === 0 && real > 0 && anual > 0) {
        causas.push({
          tipo: 'calendario', peso: real * 0.5,
          texto: 'El presupuesto de la partida (' + fmt(anual) + ' al año) estaba en otros meses.'
        });
      }
    }
    if (ppto === 0 && real !== 0 && sum(bl, 0, 11) === 0 && t !== SIN_GASTO && t !== SIN_INGRESO) {
      causas.push({ tipo: 'sin-ppto', peso: Math.abs(real) * 0.9, texto: 'La partida no tiene presupuesto este año: todo lo gastado cuenta como desviación.' });
    }
    if (t === SIN_GASTO || t === SIN_INGRESO) {
      causas.push({ tipo: 'sin-clasificar', peso: Math.abs(real), texto: cur.length + ' movimientos sin clasificar. Clasificarlos moverá esta desviación a su partida real.' });
    }
    if (p.tipo === 'Ingreso' && desv < 0 && real === 0 && ppto > 0) {
      causas.push({ tipo: 'falta', peso: ppto, texto: 'No ha llegado ningún ingreso de esta partida en el periodo (presupuestados ' + fmt(ppto) + '). Si sí ha llegado, puede estar entrando por la regla de otra partida.' });
    }
    if (p.tipo !== 'Ingreso' && real === 0 && ppto > 0 && !esBolsa) {
      causas.push({ tipo: 'falta', peso: ppto, texto: 'No hay ningún cargo en esta partida (presupuestados ' + fmt(ppto) + '). O no se ha gastado, o se paga por otra vía (efectivo, Bizum, otra cuenta) y acaba en otra partida: crea una regla para esos pagos.' });
    }
    if (!esBolsa && ppto > 0 && real > 3 * ppto && real - ppto >= 300) {
      causas.push({ tipo: 'irreal', peso: (real - ppto) * 0.7, texto: 'El presupuesto (' + fmt(ppto) + ') está muy por debajo de lo que se gasta de forma habitual: ' + fmt(real / nMeses) + ' al mes de media. Conviene revisarlo para el año que viene.' });
    }

    // si es un desfase de calendario, "no hay cargos" es engañoso: sobra
    if (causas.some(function (c) { return c.tipo === 'calendario'; })) causas = causas.filter(function (c) { return c.tipo !== 'falta'; });

    // sin otra explicación: compara importes mes a mes contra el presupuesto
    if (!esBolsa && !causas.length && Math.abs(desv) >= 50 && cur.length > 2) {
      var meses = [];
      for (var q = desde; q <= hasta; q++) {
        var rq = (porMes[q] || []).reduce(function (s, m) { return s + val(m); }, 0);
        if (Math.abs(rq - bl[q - 1]) >= 25) meses.push({ mes: q, d: rq - bl[q - 1], r: rq });
      }
      meses.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
      if (meses.length) {
        causas.push({
          tipo: 'importe', peso: Math.abs(desv),
          texto: 'Importes distintos a lo previsto en ' + meses.slice(0, 4).map(function (x) { return MESES[x.mes - 1] + ' (' + fmt(x.r) + ', ' + fmtSigned(x.d) + ')'; }).join(', ') + (meses.length > 4 ? '…' : '') + '.'
        });
      }
    }

    // pocos movimientos y ninguna otra explicación: decir qué importe llegó frente a lo previsto
    if (!causas.length && !esBolsa && cur.length >= 1 && cur.length <= 2 && Math.abs(desv) >= 50) {
      causas.push({
        tipo: 'importe', peso: Math.abs(desv),
        texto: (cur.length === 1 ? 'Un único ' : 'Dos ') + (p.tipo === 'Ingreso' ? 'cobro' : 'cargo') + (cur.length === 1 ? '' : 's') + ': ' +
          cur.map(function (m) { return merchantKey(m) + ' ' + fmt(val(m)) + ' (' + m.fecha.slice(8, 10) + '/' + m.fecha.slice(5, 7) + ')'; }).join(', ') +
          ', frente a ' + fmt(ppto) + ' previstos (' + fmtSigned(desv) + ').'
      });
    }

    causas.sort(function (a, b) { return b.peso - a.peso; });
    return {
      tipologia: t, bloque: p.bloque, tipo: p.tipo, desde: desde, hasta: hasta,
      real: real, ppto: ppto, desv: desv, n: cur.length,
      causas: causas.slice(0, 4), comercios: comercios.slice(0, 8),
      nota: opts.notas ? cur.filter(function (m) { return m.nota; }).map(function (m) { return m.nota; }) : []
    };
  }

  /**
   * Las desviaciones que más pesan en un periodo, ordenadas por impacto en el ahorro.
   * impacto > 0 = te ha costado dinero (gasto de más o ingreso de menos).
   */
  function topDeviations(opts) {
    var s = summarize({ year: opts.year, partidas: opts.partidas, movimientos: opts.movimientos, presupuesto: opts.presupuesto, hasta: opts.hasta, umbrales: opts.umbrales });
    var desde = opts.desde || 1, hasta = opts.hasta || s.hasta;
    var rows = s.filas.map(function (f) {
      var r = round2(sum(f.real, desde - 1, hasta - 1)), b = round2(sum(f.ppto, desde - 1, hasta - 1));
      var d = round2(r - b);
      return { tipologia: f.tipologia, tipo: f.tipo, bloque: f.bloque, real: r, ppto: b, desv: d, impacto: f.tipo === 'Ingreso' ? -d : d };
    }).filter(function (r) { return Math.abs(r.desv) >= (opts.minimo || 50); });
    rows.sort(function (a, b) { return Math.abs(b.impacto) - Math.abs(a.impacto); });
    var limit = opts.limit || 8;
    return rows.slice(0, limit).map(function (r) {
      var e = explainLine({ tipologia: r.tipologia, year: opts.year, desde: desde, hasta: hasta, ultimoMes: s.hasta, partidas: opts.partidas, movimientos: opts.movimientos, presupuesto: opts.presupuesto, notas: true });
      e.impacto = r.impacto;
      return e;
    });
  }

  // ---------------------------------------------------------- importar Excel

  /**
   * Convierte las hojas del Excel actual (BUDGET_HOME.xlsx) en datos de la app.
   * grids: { Maestro_Tipologias, Reglas_Categorizacion, FC } como rejillas de valores.
   */
  function importFromBudgetWorkbook(grids, year) {
    var partidas = [], seen = {};
    var addPartida = function (t, bloque, tipo) {
      t = String(t || '').trim();
      if (!t || seen[norm(t)] || /^SIN CLASIFICA/.test(norm(t))) return;
      seen[norm(t)] = t;
      tipo = /ingreso/i.test(tipo) ? 'Ingreso' : /traspaso/i.test(tipo) ? 'Traspaso' : 'Gasto';
      partidas.push({ tipologia: t, bloque: String(bloque || '').trim().toUpperCase() || 'OTROS', tipo: tipo });
    };
    var canon = function (t) { t = String(t || '').trim(); return seen[norm(t)] || t; };

    var mt = grids.Maestro_Tipologias || [];
    for (var i = 0; i < mt.length; i++) {
      var r = mt[i] || [];
      if (norm(r[0]) === 'TIPOLOGIA') continue;
      if (/CONTROL DE INTEGRIDAD/.test(norm(r[2]))) break;
      if (!r[0] || String(r[0]).charAt(0) === '=' || /^MAESTRO/.test(norm(r[0]))) continue;
      if (/PENDIENTE/.test(norm(r[3])) || norm(r[1]) === 'SIN CLASIFICAR') continue;
      addPartida(r[0], r[1], r[2]);
    }
    var fc = grids.FC || [], presupuesto = [];
    for (var j = 1; j < fc.length; j++) {
      var f = fc[j] || [];
      var mes = monthIndex(f[0]);
      var t = String(f[4] || '').trim();
      if (!mes || !t || /^SIN CLASIFICA/.test(norm(t))) continue;
      addPartida(t, f[5], f[1]);
      var imp = parseAmount(f[3]);
      if (isFinite(imp) && imp !== 0) presupuesto.push({ anio: Number(year), mes: mes, tipologia: canon(t), importe: round2(Math.abs(imp)), comentario: String(f[6] || '').trim() });
    }
    var rg = grids.Reglas_Categorizacion || [], reglas = [];
    for (var k = 1; k < rg.length; k++) {
      var x = rg[k] || [];
      if (!x[0] || !x[1]) continue;
      addPartida(x[1], x[2], /INGRESOS/.test(norm(x[2])) ? 'Ingreso' : /TRASPASOS/.test(norm(x[2])) ? 'Traspaso' : 'Gasto');
      reglas.push({ patron: String(x[0]).trim(), tipologia: canon(x[1]), signo: '', min: '', max: '', meses: '', comentario: x[3] ? String(x[3]).trim() : '', origen: 'excel' });
    }
    // agrupar presupuesto repetido (misma partida y mes en varias filas)
    var agg = {};
    presupuesto.forEach(function (b) {
      var key = b.mes + '|' + b.tipologia;
      if (agg[key]) { agg[key].importe = round2(agg[key].importe + b.importe); if (b.comentario && agg[key].comentario.indexOf(b.comentario) < 0) agg[key].comentario += (agg[key].comentario ? ' · ' : '') + b.comentario; }
      else agg[key] = b;
    });
    return { partidas: partidas, presupuesto: Object.keys(agg).map(function (k) { return agg[k]; }), reglas: reglas };
  }

  return {
    MESES: MESES, MESES_CORTO: MESES_CORTO, TIPOS: TIPOS, SIN_GASTO: SIN_GASTO, SIN_INGRESO: SIN_INGRESO,
    UMBRAL_PROPUESTA: UMBRAL_PROPUESTA,
    norm: norm, round2: round2, ymd: ymd, toDate: toDate, parseAmount: parseAmount, hash: hash, monthIndex: monthIndex,
    parseStatement: parseStatement, movementId: movementId, chronoSort: chronoSort, checkBalance: checkBalance,
    prepareRules: prepareRules, matchRule: matchRule, merchantKey: merchantKey, suggestPattern: suggestPattern,
    tokens: tokens, buildSuggester: buildSuggester, suggest: suggest, classifyAll: classifyAll,
    realByLine: realByLine, budgetByLine: budgetByLine, lastMonthWithData: lastMonthWithData, status: status,
    summarize: summarize, forecast: forecast, detectManualEdits: detectManualEdits,
    explainLine: explainLine, topDeviations: topDeviations,
    importFromBudgetWorkbook: importFromBudgetWorkbook, fmt: fmt, fmtSigned: fmtSigned
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FB;


// ===================================================== servidor

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
