#!/usr/bin/env python3
"""
Parse Interbank Peru AMEX card screenshots using Gemini and load to BigQuery.

Usage:
  export GEMINI_API_KEY=your_key_here   # free key from https://aistudio.google.com/app/apikey
  python scripts/interbank_parse.py ~/Downloads/WhatsApp*.jpeg

Requirements:
  pip install google-generativeai
"""

import os
import sys
import json
import base64
import math
import datetime
import subprocess
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────
CARD_NAME  = "Interbank AMEX 6765"
BQ_TABLE   = "spark-datahub.cashflow.data_bank_native"
BQ_PROJECT = "spark-datahub"
GCLOUD_DIR = str(Path(__file__).parent.parent / ".gcloud")

# ── Category heuristics (merchant substring → category) ────────────────────────
MERCHANT_CATEGORY = [
    ("rewe",              "Groceries"),
    ("kaufland",          "Groceries"),
    ("aldi",              "Groceries"),
    ("lidl",              "Groceries"),
    ("edeka",             "Groceries"),
    ("wolt",              "Delivery"),
    ("pedidosya",         "Delivery"),
    ("shift4*wolt",       "Delivery"),
    ("deliveroo",         "Delivery"),
    ("uber eats",         "Delivery"),
    ("uber",              "Transport"),
    ("tfl",               "Transport"),
    ("bvg",               "Transport"),
    ("openai",            "Subscription"),
    ("chatgpt",           "Subscription"),
    ("netflix",           "Subscription"),
    ("spotify",           "Subscription"),
    ("movistar",          "Network"),
    ("vodafone",          "Network"),
    ("amazon",            "Other"),
    ("amzn",              "Other"),
    ("ikea",              "Housing"),
    ("zara",              "Clothing"),
    ("h&m",               "Clothing"),
    ("kg zara",           "Clothing"),
    ("vitapoint",         "Health"),
    ("dm ",               "Health"),
    ("apotheke",          "Health"),
    ("ben rahim",         "Food"),
    ("le crobag",         "Food"),
    ("3cpayment",         "Food"),
    ("hackescher",        "Food"),
    ("seguro",            "Other"),
]

CATEGORY_MAP = {
    "Delivery":           {"finance_category": "5. True Cash Flow",         "finance_class": "Expected Cost of Living"},
    "Pet":                {"finance_category": "5. True Cash Flow",         "finance_class": "Expected Cost of Living"},
    "Food":               {"finance_category": "4. Quality of Life Margin", "finance_class": "Expected Cost of Living"},
    "Service":            {"finance_category": "4. Quality of Life Margin", "finance_class": "Expected Cost of Living"},
    "Services":           {"finance_category": "4. Quality of Life Margin", "finance_class": "Expected Cost of Living"},
    "Subscription":       {"finance_category": "4. Quality of Life Margin", "finance_class": "Expected Cost of Living"},
    "Groceries":          {"finance_category": "3. Vital Surplus",          "finance_class": "Expected Cost of Living"},
    "Health":             {"finance_category": "3. Vital Surplus",          "finance_class": "Expected Cost of Living"},
    "Non Food Groceries": {"finance_category": "3. Vital Surplus",          "finance_class": "Expected Cost of Living"},
    "Hair":               {"finance_category": "3. Vital Surplus",          "finance_class": "Expected Cost of Living"},
    "Parking":            {"finance_category": "3. Vital Surplus",          "finance_class": "Expected Cost of Living"},
    "Transport":          {"finance_category": "3. Vital Surplus",          "finance_class": "Expected Cost of Living"},
    "Network":            {"finance_category": "2. Foundational Margin",    "finance_class": "Expected Cost of Living"},
    "Rent":               {"finance_category": "2. Foundational Margin",    "finance_class": "Expected Rent"},
    "Clothing":           {"finance_category": "5. True Cash Flow",         "finance_class": "Extra & One-Offs"},
    "Other":              {"finance_category": "5. True Cash Flow",         "finance_class": "Extra & One-Offs"},
    "Tech":               {"finance_category": "5. True Cash Flow",         "finance_class": "Extra & One-Offs"},
    "Trip":               {"finance_category": "5. True Cash Flow",         "finance_class": "Extra & One-Offs"},
    "Housing":            {"finance_category": "3. Vital Surplus",          "finance_class": "Extra & One-Offs"},
    "Income":             {"finance_category": "1. Earnings Net",           "finance_class": ""},
}

MONTH_MAP = {
    "Ene": "01", "Feb": "02", "Mar": "03", "Abr": "04",
    "May": "05", "Jun": "06", "Jul": "07", "Ago": "08",
    "Sep": "09", "Oct": "10", "Nov": "11", "Dic": "12",
}

# ── Helpers ────────────────────────────────────────────────────────────────────

def parse_date(date_raw: str, year: int = 2026) -> str:
    """'16 Abr' → '2026-04-16'"""
    parts = date_raw.strip().split()
    day   = parts[0].zfill(2)
    month = MONTH_MAP[parts[1]]
    return f"{year}-{month}-{day}"

def compute_amounts(original: float, currency: str):
    """Returns (eur, pen, usd) from original amount in given currency."""
    if currency == "usd":
        eur = round(original / 1.08, 2)
        pen = round(eur * 4, 2)
        usd = original
    elif currency == "pen":
        eur = round(original / 4, 2)
        usd = round(eur * 1.08, 2)
        pen = original
    else:  # eur
        eur = original
        pen = round(eur * 4, 2)
        usd = round(eur * 1.08, 2)
    return eur, pen, usd

def get_week(date_str: str) -> str:
    """Match the JS getWeek() logic in classify.js."""
    d     = datetime.date.fromisoformat(date_str)
    start = datetime.date(d.year, 1, 1)
    # JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat
    # Python weekday(): 0=Mon, ..., 6=Sun → convert: (weekday+1)%7
    js_start_day = (start.weekday() + 1) % 7
    days_diff    = (d - start).days
    week         = math.ceil((days_diff + js_start_day + 1) / 7)
    return f"Week {week}"

def get_month(date_str: str) -> str:
    d = datetime.date.fromisoformat(date_str)
    return f"{d.year}-{str(d.month).zfill(2)}-01"

def guess_category(merchant: str) -> str:
    lower = merchant.lower()
    for keyword, cat in MERCHANT_CATEGORY:
        if keyword in lower:
            return cat
    return "Other"

# ── Gemini extraction ──────────────────────────────────────────────────────────

GEMINI_PROMPT = """Extract ALL transactions from this Interbank Peru mobile app screenshot.

Return ONLY a valid JSON array (no markdown, no explanation) with this structure:
[
  {
    "date_raw": "16 Abr",
    "merchant": "Rewe markt",
    "amount": -29.86,
    "currency": "usd",
    "is_payment": false
  }
]

Rules:
- date_raw: day + abbreviated month ONLY (e.g. "16 Abr"), NO day-of-week prefix
- currency: "usd" for amounts prefixed with "US$", "pen" for amounts prefixed with "S/"
- amount: preserve sign exactly (negative for expenses, positive for payments)
- is_payment: true for "Pago tarj web app" and any other credit/payment in green
- Skip "Envio est. de cuenta" with S/ 0.00
- Include "En proceso" transactions (still include them)
- Return ONLY the raw JSON array"""

def extract_from_images(image_paths: list) -> list:
    try:
        import google.generativeai as genai
    except ImportError:
        print("ERROR: google-generativeai not installed.")
        print("Run: pip install google-generativeai")
        sys.exit(1)

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("ERROR: GEMINI_API_KEY environment variable not set.")
        print("Get a free key at: https://aistudio.google.com/app/apikey")
        sys.exit(1)

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.0-flash")

    all_transactions = []

    for img_path in image_paths:
        name = Path(img_path).name
        print(f"  Processing {name}...", end=" ", flush=True)

        with open(img_path, "rb") as f:
            image_data = base64.b64encode(f.read()).decode()

        response = model.generate_content([
            GEMINI_PROMPT,
            {"mime_type": "image/jpeg", "data": image_data},
        ])

        text = response.text.strip()

        # Strip ```json ... ``` if Gemini wraps it anyway
        if text.startswith("```"):
            lines = text.split("\n")
            text  = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])

        try:
            txns = json.loads(text)
            print(f"{len(txns)} transactions")
            all_transactions.extend(txns)
        except json.JSONDecodeError as e:
            print(f"PARSE ERROR: {e}")
            print(f"  Raw response: {text[:300]}")

    return all_transactions

# ── Deduplication ──────────────────────────────────────────────────────────────

def deduplicate(transactions: list) -> list:
    seen   = set()
    unique = []
    for t in transactions:
        key = (t["date_raw"], t["merchant"].lower(), t["amount"], t["currency"])
        if key not in seen:
            seen.add(key)
            unique.append(t)
    return unique

# ── Build BigQuery rows ────────────────────────────────────────────────────────

def build_rows(transactions: list, year: int = 2026) -> list:
    rows = []
    for t in transactions:
        if t.get("is_payment", False):
            continue
        if t["amount"] == 0:
            continue

        date_str = parse_date(t["date_raw"], year)
        category = guess_category(t["merchant"])
        mapping  = CATEGORY_MAP.get(category, CATEGORY_MAP["Other"])
        eur, pen, usd = compute_amounts(t["amount"], t["currency"])

        rows.append({
            "date":                    date_str,
            "card":                    CARD_NAME,
            "category":                category,
            "subcategory":             None,
            "city":                    None,
            "commerce":                t["merchant"],
            "original_amount":         t["amount"],
            "currency_original_amount": t["currency"],
            "pen_amount":              pen,
            "usd_amount":              usd,
            "eur_amount":              eur,
            "month":                   get_month(date_str),
            "week":                    get_week(date_str),
            "finance_class":           mapping["finance_class"],
            "finance_category":        mapping["finance_category"],
        })

    return sorted(rows, key=lambda r: r["date"])

# ── BigQuery insert ────────────────────────────────────────────────────────────

def insert_to_bigquery(rows: list) -> bool:
    ndjson = "\n".join(json.dumps(r, default=str) for r in rows)

    cmd = [
        "bq", "insert",
        f"--project_id={BQ_PROJECT}",
        BQ_TABLE,
    ]

    env = {**os.environ, "CLOUDSDK_CONFIG": GCLOUD_DIR}

    result = subprocess.run(
        cmd,
        input=ndjson,
        text=True,
        capture_output=True,
        env=env,
    )

    if result.returncode != 0 or result.stderr.strip():
        print(f"ERROR: {result.stderr}")
        return False
    if result.stdout.strip():
        print(f"BQ: {result.stdout.strip()}")
    return True

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    image_paths = sys.argv[1:]
    missing = [p for p in image_paths if not Path(p).exists()]
    if missing:
        print(f"ERROR: Files not found: {missing}")
        sys.exit(1)

    print(f"\nExtracting transactions from {len(image_paths)} image(s)...")
    raw    = extract_from_images(image_paths)
    unique = deduplicate(raw)
    print(f"\n{len(raw)} total → {len(unique)} unique after dedup")

    rows = build_rows(unique)
    if not rows:
        print("No expense transactions found.")
        return

    # Preview
    SEP = "─" * 84
    print(f"\n{SEP}")
    print(f"{'DATE':<12} {'MERCHANT':<30} {'ORIG':>10} {'CUR':<4} {'EUR':>8}  {'CATEGORY'}")
    print(SEP)
    for r in rows:
        print(
            f"{r['date']:<12} {r['commerce'][:30]:<30} "
            f"{r['original_amount']:>10.2f} {r['currency_original_amount']:<4} "
            f"{r['eur_amount']:>8.2f}  {r['category']}"
        )
    print(SEP)
    total_eur = sum(r["eur_amount"] for r in rows)
    print(f"  {len(rows)} transactions   EUR total: {total_eur:.2f}")
    print()

    answer = input(f"Insert {len(rows)} rows to BigQuery? [y/N]: ").strip().lower()
    if answer != "y":
        print("Aborted.")
        return

    print("Inserting...")
    if insert_to_bigquery(rows):
        print(f"✓ Inserted {len(rows)} rows to {BQ_TABLE}")
    else:
        print("✗ Insert failed")

if __name__ == "__main__":
    main()
