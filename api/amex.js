// POST /api/amex
// Body: { images: [{ name: string, data: string (base64 JPEG) }] }
// Returns: { transactions: [...] }
// Requires env var: GEMINI_API_KEY (free key from https://aistudio.google.com/app/apikey)

const MONTH_MAP = {
  'Ene':'01','Feb':'02','Mar':'03','Abr':'04',
  'May':'05','Jun':'06','Jul':'07','Ago':'08',
  'Sep':'09','Oct':'10','Nov':'11','Dic':'12',
};

function parseDate(dateRaw, year) {
  // "16 Abr" → "2026-04-16"
  const [day, mon] = dateRaw.trim().split(' ');
  return `${year}-${MONTH_MAP[mon] || '01'}-${day.padStart(2,'0')}`;
}

function computeEur(amount, currency) {
  if (currency === 'usd') return Math.round(amount / 1.08 * 100) / 100;
  if (currency === 'pen') return Math.round(amount / 4    * 100) / 100;
  return amount;
}

function getWeek(dateStr) {
  const d = new Date(dateStr), start = new Date(d.getFullYear(), 0, 1);
  return `Week ${Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7)}`;
}

function getMonth(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

const prompt = (year) => `Extract ALL transactions from this Interbank Peru mobile banking screenshot.
Year is ${year}.

Return ONLY a valid JSON array — no markdown, no explanation:
[{ "date_raw":"16 Abr", "merchant":"Rewe markt", "amount":-29.86, "currency":"usd", "is_payment":false, "en_proceso":false }]

Rules:
- date_raw: day + Spanish month abbreviation ONLY e.g. "16 Abr" (no day-of-week)
- currency: "usd" for US$ amounts, "pen" for S/ amounts
- amount: exact number with sign (negative = expense, positive = credit/payment)
- is_payment: true for "Pago tarj web app" or any green positive payment entry
- en_proceso: true if the row shows "En proceso" status text
- Skip rows with amount exactly 0 (e.g. "Envio est. de cuenta S/ -0.00")
- Return ONLY the raw JSON array`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel env vars' });

  const { images, year = new Date().getFullYear() } = req.body;
  if (!images?.length) return res.status(400).json({ error: 'No images provided' });

  const CARD = 'Interbank AMEX 6765';
  const allRaw = [];
  const debugLog = [];

  for (const img of images) {
    try {
      // Detect mime type from filename
      const mimeType = img.name?.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt(year) },
              { inline_data: { mime_type: mimeType, data: img.data } },
            ]}],
            generationConfig: { temperature: 0, response_mime_type: 'application/json' },
          }),
        }
      );

      if (!r.ok) {
        const errBody = await r.text();
        debugLog.push({ file: img.name, error: `Gemini HTTP ${r.status}`, detail: errBody.slice(0, 300) });
        console.error(`Gemini ${r.status} for ${img.name}:`, errBody.slice(0, 300));
        continue;
      }

      const gd   = await r.json();
      let   text = gd.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
      debugLog.push({ file: img.name, raw: text.slice(0, 500) });
      text = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();

      const txns = JSON.parse(text);
      debugLog[debugLog.length - 1].parsed = txns.length;
      allRaw.push(...txns);
    } catch (e) {
      debugLog.push({ file: img.name, error: e.message });
      console.error(`Error on ${img.name}:`, e.message);
    }
  }

  // Deduplicate across screenshots
  const seen = new Set();
  const unique = [];
  for (const t of allRaw) {
    const key = `${t.date_raw}|${(t.merchant||'').toLowerCase()}|${t.amount}|${t.currency}`;
    if (!seen.has(key)) { seen.add(key); unique.push(t); }
  }

  // Build rows (expenses only)
  const rows = unique
    .filter(t => !t.is_payment && t.amount !== 0)
    .map(t => {
      const dateStr = parseDate(t.date_raw, year);
      const eur     = computeEur(t.amount, t.currency);
      return {
        date:            dateStr,
        card:            CARD,
        commerce:        t.merchant,
        original_amount: t.amount,
        currency:        t.currency,
        eur_amount:      eur,
        month:           getMonth(dateStr),
        week:            getWeek(dateStr),
        en_proceso:      t.en_proceso || false,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  return res.status(200).json({ transactions: rows, debug: debugLog });
}
