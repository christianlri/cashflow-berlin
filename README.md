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

## Local Development

No local server needed — all APIs run on Vercel. To test locally you'd need `vercel dev` with env vars set.

```bash
# Preview latest deployment
vercel --prod
```
