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
