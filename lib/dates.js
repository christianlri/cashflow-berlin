// Shared date helpers for the Interbank (AMEX / Premia) ingestion pipeline.
//
// Two bugs used to live here, duplicated across api/amex.js and api/classify.js:
//
//  1. El mapa de meses no tenía "Set". Interbank Perú escribe septiembre como
//     "Set" (no "Sep"), y el lookup fallido caía silenciosamente en '01', así
//     que los gastos de setiembre se guardaban en enero.
//  2. getMonth()/getWeek() hacían `new Date('2026-09-01')` — que es medianoche
//     UTC — y luego leían getFullYear()/getMonth(), que son locales. En cualquier
//     zona con offset negativo (America/Lima) el día 1 retrocedía al mes
//     anterior: un gasto del 1 de setiembre entraba como agosto.
//
// Todo acá es aritmética de strings / UTC: mismo resultado en cualquier TZ.

// Abreviaturas → mes. Se normaliza la clave (minúsculas, sin tildes, sin punto)
// antes de buscar, así que acá van solo formas en minúscula.
const MONTHS = {
  ene: '01', enero: '01',
  feb: '02', febrero: '02',
  mar: '03', marzo: '03',
  abr: '04', abril: '04',
  may: '05', mayo: '05',
  jun: '06', junio: '06',
  jul: '07', julio: '07',
  ago: '08', agosto: '08',
  // Interbank usa "Set"; otros exports usan "Sep"/"Sept".
  set: '09', sep: '09', sept: '09', setiembre: '09', septiembre: '09',
  oct: '10', octubre: '10',
  nov: '11', noviembre: '11',
  dic: '12', diciembre: '12',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeToken(token) {
  return token
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // tildes: "Mié" → "Mie"
    .replace(/[.,]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * "16 Abr" / "09 Set" / "Mié 09 Set" / "09 de setiembre" → "2026-09-09".
 * Devuelve null si no se puede parsear con confianza — nunca inventa enero.
 */
function parseDate(dateRaw, year) {
  if (!dateRaw) return null;

  const raw = String(dateRaw).trim();
  if (DATE_RE.test(raw)) return raw;  // Gemini ya devolvió ISO

  const tokens = raw.split(/[\s/-]+/).map(normalizeToken).filter(Boolean);

  let day = null;
  let month = null;
  for (const token of tokens) {
    if (/^\d{1,2}$/.test(token)) {
      if (day === null) day = parseInt(token, 10);   // el día precede al mes
    } else if (MONTHS[token] && month === null) {
      month = MONTHS[token];
    }
  }

  if (day === null || month === null) return null;
  if (day < 1 || day > 31) return null;

  const y = parseInt(year, 10);
  if (!Number.isInteger(y)) return null;

  return `${y}-${month}-${String(day).padStart(2, '0')}`;
}

/** Primer día del mes de una fecha ISO. Puro string: inmune a la TZ del runtime. */
function getMonth(dateStr) {
  const s = String(dateStr).slice(0, 10);
  if (!DATE_RE.test(s)) return null;
  return `${s.slice(0, 7)}-01`;
}

/**
 * Semana del año, con la misma numeración que usaba el getWeek() original
 * (semanas que arrancan en domingo, la del 1 de enero es la Week 1),
 * para no romper las filas ya cargadas en BigQuery. Todo en UTC.
 */
function getWeek(dateStr) {
  const s = String(dateStr).slice(0, 10);
  if (!DATE_RE.test(s)) return null;

  const [y, m, d] = s.split('-').map(Number);
  const date = Date.UTC(y, m - 1, d);
  const start = Date.UTC(y, 0, 1);
  const startDay = new Date(start).getUTCDay();   // 0 = domingo
  const daysDiff = (date - start) / 86400000;
  return `Week ${Math.ceil((daysDiff + startDay + 1) / 7)}`;
}

module.exports = { MONTHS, parseDate, getMonth, getWeek };
