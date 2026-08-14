# Cashflow Berlin — Palette

Personal finance dashboard and transaction classifier for N26 and Interbank AMEX cards. Deployed on Vercel, backed by BigQuery.

---

## Stack

- **Frontend:** Vanilla HTML/JS, Outfit font, deployed as static files on Vercel
- **Backend:** Vercel serverless functions (Node.js, ESM)
- **Database:** BigQuery — `spark-datahub.cashflow.data_bank_native`
- **AI:** Gemini 2.5 Flash (vision) for Interbank screenshot parsing
- **Auth:** GCP service account credentials via Vercel env vars

---

## Pages

| Route | File | Description |
|---|---|---|
| `/palette` | `palette.html` | Main dashboard — spending overview by category |
| `/clasificar` | `clasificar.html` | N26 CSV classifier — upload CSVs, classify, load to BQ |
| `/amex` | `amex.html` | Interbank AMEX classifier — upload screenshots, AI extracts transactions, classify, load to BQ |
| `/despensa` | `despensa.html` | Grocery receipt tracker |

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/transactions` | GET | Fetch transactions from BigQuery |
| `/api/summary` | GET | Aggregated spending summary |
| `/api/classify` | GET | Fetch vendorMap (historical categories) from BQ |
| `/api/classify` | POST | Insert classified rows into BigQuery |
| `/api/amex` | POST | Process Interbank screenshots via Gemini, return extracted transactions |
| `/api/receipts` | GET/POST | Grocery receipt data |

---

## Required Environment Variables (Vercel)

| Variable | Description |
|---|---|
| `GCP_PROJECT_ID` | GCP project ID (`spark-datahub`) |
| `GCP_CREDENTIALS` | Service account JSON (stringified) |
| `GEMINI_API_KEY` | Gemini API key — get free key at https://aistudio.google.com/app/apikey |

---

## Interbank AMEX Module (`/amex`)

Upload one or more screenshots from Interbank Peru app → **Mi tarjeta → Movimientos**.

Flow:
1. Screenshots are base64-encoded client-side
2. Sent one at a time to `/api/amex` (avoids Vercel 4.5MB body limit)
3. Gemini 2.5 Flash extracts transactions (date, merchant, amount, currency, en_proceso)
4. Client deduplicates across overlapping screenshots
5. Known merchants auto-classified from BQ history (`vendorMap`)
6. Unknown merchants matched via inference rules (keyword → category)
7. User reviews and adjusts, then clicks **Cargar a BigQuery**
8. Inserts via `/api/classify` POST (same endpoint as N26)

Currencies supported: `usd` (US$) and `pen` (S/). Converted to EUR at:
- USD → EUR: `amount / 1.08`
- PEN → EUR: `amount / 4`

Card name in BQ: `Interbank AMEX 6765`

---

## N26 Module (`/clasificar`)

Upload N26 CSV exports. Transactions are classified and inserted into BigQuery via `/api/classify`.

---

## Categorías

`CATEGORY_MAP` (categoría → `finance_class` + `finance_category`) está duplicado en cuatro
sitios y los cuatro tienen que quedar idénticos al agregar una categoría:

- `api/classify.js` — **fuente de verdad**, es la que escribe en BQ
- `clasificar.html`, `amex.html` — copias para la UI
- `scripts/interbank_parse.py`

Además hay que dar de alta la categoría nueva en `palette.html` (`CATEGORY_TARGETS`,
`CAT_COLORS`, `FOCUS_CATS`, y `ONEOFF_CATS` si es gasto irregular) o no aparece en el
dashboard, y en el nodo `Match Categories` del n8n.

Una categoría que no esté en `CATEGORY_MAP` ya no desaparece del P&L: cae en el bucket de
`Other` (`5. True Cash Flow` / `Extra & One-Offs`) y `/api/classify` la devuelve en
`warnings`. Antes caía en `Not Considered` en silencio.

---

## BigQuery Table Schema (`data_bank_native`)

| Field | Type |
|---|---|
| `date` | DATE |
| `card` | STRING |
| `category` | STRING |
| `subcategory` | STRING |
| `city` | STRING |
| `commerce` | STRING |
| `original_amount` | FLOAT |
| `currency_original_amount` | STRING |
| `pen_amount` | FLOAT |
| `usd_amount` | FLOAT |
| `eur_amount` | FLOAT |
| `month` | DATE |
| `week` | STRING |
| `finance_class` | STRING |
| `finance_category` | STRING |

---

## WhatsApp Pipeline (n8n)

Automated ingestion via WhatsApp photo → Gemini OCR → BigQuery. Runs on [n8n Cloud](https://spark-data.app.n8n.cloud).

### Flow

```
WhatsApp photo (Twilio)
  → Download Image       (n8n HTTP Request — Twilio Basic Auth)
  → To Base64            (n8n Move Binary Data)
  → Build Gemini Body    (n8n Code)
  → Gemini OCR           (n8n HTTP Request — Gemini 2.5 Flash)
  → Parse Transactions   (n8n Code)
  → Group Rows           (n8n Code — adds card name)
  → Fetch Vendor Map     (GET /api/classify)
  → Match Categories     (n8n Code — vendorMap + inference rules)
  → Load to BigQuery     (POST /api/classify)
```

### Node Code

**Build Gemini Body**
```javascript
const item = $input.first();
const imageData = item.json.data;
const mimeType = 'image/jpeg';
const today = new Date().toISOString().split('T')[0];

return [{
  json: {
    geminiBody: {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageData } },
          { text: `Today's date is ${today}. Analyze this bank statement screenshot and extract all transactions. Return a JSON array where each item has: date (YYYY-MM-DD), commerce (merchant name), eur_amount (negative for expenses), currency (eur/usd/pen), original_amount. Only return the JSON array, nothing else.` }
        ]
      }]
    }
  }
}];
```

**Parse Transactions**
```javascript
const text = $input.first().json.candidates[0].content.parts[0].text;
const cleaned = text.replace(/```json\n?/, '').replace(/```$/, '').trim();
const transactions = JSON.parse(cleaned);
return transactions.map(t => ({ json: t }));
```

**Group Rows**
```javascript
const rows = $input.all().map(i => ({
  ...i.json,
  card: 'Interbank AMEX 6765',
  category: 'Other'
}));
return [{ json: { rows } }];
```

**Match Categories**
```javascript
const vendorMap = $('Fetch Vendor Map').first().json.vendorMap;
const rows = $('Group Rows').first().json.rows;

const INFERENCE_RULES = [
  { kw: ['rewe', 'kaufland', 'lidl', 'netto', 'aldi', 'edeka', 'mustafa', 'denns', 'bio company'], cat: 'Groceries' },
  { kw: ['wolt', 'pedidosya', 'lieferando', 'uber eats'], cat: 'Delivery' },
  { kw: ['le crobag', 'burger king', 'mcdonald', 'starbucks', 'restaurant', 'cafe'], cat: 'Food' },
  { kw: ['bvg', 'bolt', 'lime', 'tier', 'uber trip'], cat: 'Transport' },
  { kw: ['apotheke', 'urban sports'], cat: 'Health' },
  { kw: ['openai', 'chatgpt', 'spotify', 'netflix', 'audible', 'proton', 'apple.com/bill', 'claude.ai'], cat: 'Subscription' },
  { kw: ['zara', 'uniqlo', 'h&m', 'decathlon', 'zalando', 'tk maxx'], cat: 'Clothing' },
  { kw: ['mediamarkt', 'samsung', 'anthropic'], cat: 'Tech' },
  { kw: ['uci ', 'multiplex', 'zoo palast', 'cineplanet', 'cinemark', 'theater', 'eventim', 'dazn'], cat: 'Entertainment' },
  { kw: ['amzn mktp', 'amazon', 'kindle svcs', 'temu', 'catawiki'], cat: 'Online Shopping' },
  { kw: ['ikea', 'bauhaus', 'obi', 'hornbach'], cat: 'Housing' },
  { kw: ['easyjet', 'ryanair', 'ibis'], cat: 'Trip' },
  { kw: ['seguro', 'desgravamen', 'revolut', 'wise', 'pago tarj'], cat: 'Finance' },
];

function infer(commerce) {
  const v = commerce.toLowerCase();
  for (const rule of INFERENCE_RULES)
    if (rule.kw.some(k => v.includes(k))) return rule.cat;
  return null;
}

return [{ json: { rows: rows.map(r => {
  const hist = vendorMap[r.commerce];
  const inf  = infer(r.commerce);
  const category = hist || inf || 'Other';
  return { ...r, category, matched: !!(hist || inf) };
})}}];
```

### Twilio Sandbox
- Number: `+1 415 523 8886`
- Webhook: `https://spark-data.app.n8n.cloud/webhook/whatsapp` (POST)
- To activate sandbox: send `join <word>` to the number via WhatsApp

### Credentials needed in n8n
| Credential | Used in |
|---|---|
| Twilio Basic Auth (Account SID + Auth Token) | Download Image |
| Gemini Header Auth (`x-goog-api-key`) | Gemini OCR |

---

## Local Development

No local server needed — all APIs run on Vercel. To test locally you'd need `vercel dev` with env vars set.

```bash
# Preview latest deployment
vercel --prod
```
