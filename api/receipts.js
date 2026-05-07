const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  credentials: JSON.parse(process.env.GCP_CREDENTIALS),
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: price history for an item ──────────────────────────────────────
  if (req.method === 'GET') {
    const { item } = req.query;
    try {
      const query = item
        ? `SELECT date, store, item_raw_name, item_friendly_name, qty, unit_price, total_price, category
           FROM \`spark-datahub.cashflow.receipt_items\`
           WHERE item_raw_name = @item
           ORDER BY date DESC
           LIMIT 50`
        : `SELECT item_raw_name, item_friendly_name, category,
             COUNT(*) as times_bought,
             MIN(unit_price) as min_price,
             MAX(unit_price) as max_price,
             AVG(unit_price) as avg_price,
             MAX(date) as last_bought
           FROM \`spark-datahub.cashflow.receipt_items\`
           GROUP BY item_raw_name, item_friendly_name, category
           ORDER BY times_bought DESC`;

      const options = item
        ? { query, params: { item }, location: 'US' }
        : { query, location: 'US' };

      const [rows] = await bigquery.query(options);
      return res.status(200).json(rows);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: parse receipt text via Claude, then insert ────────────────────
  if (req.method === 'POST') {
    const { receiptText, preItems, store, storeAddress, receiptId, date, dryRun } = req.body;

    // ── DIRECT INSERT (pre-reviewed items from frontend) ─────────────────
    if (receiptText === '__skip_parse__' && preItems?.length) {
      try {
        // Check for duplicate receipt_id
        const [existing] = await bigquery.query({
          query: `SELECT COUNT(*) as cnt FROM \`spark-datahub.cashflow.receipt_items\` WHERE receipt_id = @receiptId`,
          params: { receiptId },
          location: 'US',
        });
        if (existing[0]?.cnt > 0) {
          return res.status(409).json({ error: `Este ticket ya fue cargado (${receiptId})` });
        }

        const rows = preItems.map(item => ({
          date,
          store:              store || 'REWE',
          store_address:      storeAddress || null,
          receipt_id:         receiptId,
          item_raw_name:      item.item_raw_name,
          item_friendly_name: item.item_friendly_name,
          qty:                parseFloat(item.qty)         || 1,
          unit_price:         parseFloat(item.unit_price)  || 0,
          total_price:        parseFloat(item.total_price) || 0,
          category:           item.category || 'Otros',
        }));
        const table = bigquery.dataset('cashflow').table('receipt_items');
        await table.insert(rows);
        return res.status(200).json({ inserted: rows.length });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (!receiptText) return res.status(400).json({ error: 'No receipt text' });

    // ── PARSE WITH CLAUDE ────────────────────────────────────────────────
    const prompt = `Parse this German supermarket receipt and return ONLY a JSON array. No markdown, no explanation.

Each item in the array must have:
- item_raw_name: exact name as printed on receipt (uppercase, as-is)
- item_friendly_name: human readable name in Spanish (e.g. "Aguacate", "Jugo de naranja")
- qty: quantity as number (default 1 if not shown)
- unit_price: price per unit in EUR as number
- total_price: total price for this line in EUR as number
- category: one of [Frutas y verduras, Lácteos, Carnes, Bebidas, Snacks, Limpieza, Congelados, Panadería, Otros]

Ignore: deposits (PFAND), tax lines, totals, store info, TSE signatures.

Receipt text:
${receiptText}`;

    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const claudeData = await claudeRes.json();
      if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Claude error');

      const raw  = claudeData.content?.[0]?.text || '[]';
      const clean = raw.replace(/```json|```/g, '').trim();
      const items = JSON.parse(clean);

      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No items parsed', raw });
      }

      // ── INSERT TO BQ (only if not dryRun) ───────────────────────────
      const rows = items.map(item => ({
        date,
        store:               store || 'REWE',
        store_address:       storeAddress || null,
        receipt_id:          receiptId,
        item_raw_name:       item.item_raw_name,
        item_friendly_name:  item.item_friendly_name,
        qty:                 parseFloat(item.qty)         || 1,
        unit_price:          parseFloat(item.unit_price)  || 0,
        total_price:         parseFloat(item.total_price) || 0,
        category:            item.category || 'Otros',
      }));

      if (!dryRun) {
        const table = bigquery.dataset('cashflow').table('receipt_items');
        await table.insert(rows);
      }

      return res.status(200).json({ inserted: dryRun ? 0 : rows.length, items: rows });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
