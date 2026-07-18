#!/usr/bin/env python3
"""Clean legacy finance CSVs into giving_clean.csv for import into `giving_import`.

Usage:  python3 scripts/clean_finance_csv.py [finance_records_dir]

Input CSVs (any number) must share the header:
  Date, Receipt No., Membership No., Contributor, Phone, Currency, Amount, Method, Notes, Ref

Output columns:
  given_date    tithe PERIOD (YYYY-MM-01) parsed from Notes "…in <Month> [Year]";
                if the Notes has a month but no year, the year is inferred from the
                receipt date (prior year if that would land after the receipt);
                falls back to the receipt date when no month is found.
  receipt_date  actual transaction/receipt date (audit), from the Date column.
  ... plus receipt_no, membership_no, member_name, phone (first, digits), phone_raw,
      currency (PS->GBP), amount (reversals kept negative), payment_method, reference,
      notes (verbatim), category (Tithe).

Date formats handled: DD/MM/YYYY (slash) and YYYY-MM-DD (ISO). NOTE: the slash
files are day-first — verified because thousands of rows have a first field >12,
and none require month-first. Do not "fix" this to MM/DD.
"""
import csv, glob, re, sys, os

MONTHS = {}
for i, m in enumerate(['january','february','march','april','may','june','july',
                       'august','september','october','november','december']):
    MONTHS[m] = i + 1; MONTHS[m[:3]] = i + 1
RE_MY = re.compile(r'in\s+([a-z]+)\.?\s+(\d{4})', re.I)   # month + year
RE_M  = re.compile(r'in\s+([a-z]+)\b', re.I)              # month only
CUR = {'PS': 'GBP', 'GHS': 'GHS', 'USD': 'USD', '': 'GHS'}

def txn_date(d):
    d = (d or '').strip().split(' ')[0]
    if '/' in d:
        p = d.split('/'); return f"{int(p[2]):04d}-{int(p[1]):02d}-{int(p[0]):02d}"
    return d  # already ISO

def period_date(notes, fallback):
    m = RE_MY.search(notes or '')
    if m and m.group(1).lower() in MONTHS:
        return f"{int(m.group(2)):04d}-{MONTHS[m.group(1).lower()]:02d}-01"
    m = RE_M.search(notes or '')
    if m and m.group(1).lower() in MONTHS and len(fallback) >= 7:
        mo = MONTHS[m.group(1).lower()]; yr = int(fallback[:4])
        cand = f"{yr:04d}-{mo:02d}-01"
        if cand > fallback: cand = f"{yr-1:04d}-{mo:02d}-01"
        return cand
    return fallback

def first_phone(ph):
    return re.sub(r'\D', '', re.split(r'[\/,;]', (ph or '').strip())[0])

def main(dirpath):
    files = sorted(glob.glob(os.path.join(dirpath, '2*.csv')))
    if not files:
        sys.exit(f"No source CSVs found in {dirpath}")
    outpath = os.path.join(dirpath, 'giving_clean.csv')
    out = open(outpath, 'w', newline='', encoding='utf-8'); w = csv.writer(out)
    w.writerow(['given_date','receipt_date','receipt_no','membership_no','member_name',
                'phone','phone_raw','currency','amount','payment_method','reference','notes','category'])
    n = future = 0
    for f in files:
        for r in csv.DictReader(open(f, encoding='utf-8-sig')):
            if not r.get('Date'): continue
            rd = txn_date(r['Date']); gd = period_date(r.get('Notes'), rd)
            amt = (r.get('Amount') or '').strip().replace(',', '')
            try: float(amt)
            except ValueError: continue
            if gd > '2026-07-31': future += 1
            w.writerow([gd, rd, (r.get('Receipt No.') or '').strip(), (r.get('Membership No.') or '').strip(),
                        (r.get('Contributor') or '').strip(), first_phone(r.get('Phone')), (r.get('Phone') or '').strip(),
                        CUR.get((r.get('Currency') or '').strip(), 'GHS'), amt, (r.get('Method') or 'Cash').strip(),
                        (r.get('Ref') or '').strip(), (r.get('Notes') or '').strip(), 'Tithe'])
            n += 1
    out.close()
    print(f"Wrote {n} rows to {outpath} | given_date after Jul 2026: {future}")

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'finance_records')
