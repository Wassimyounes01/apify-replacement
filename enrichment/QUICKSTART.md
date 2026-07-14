# ⚡ Quick Start — 60 seconds

**Goal:** turn a list of companies into verified decision-maker emails.

### 1. Check Node is installed
```bash
node --version      # need 16 or newer
```

### 2. Try a single lookup
```bash
node enrich.cjs --domain acmecorp.com --first Jane --last Doe
```
You'll see the ranked candidate emails and which one is most likely real.

### 3. Run your list
Open `examples/companies.csv`, replace the rows with your own (columns: `domain, first_name, last_name`), then:
```bash
node enrich.cjs --in examples/companies.csv --out enriched.csv
```
Open `enriched.csv` — one best email per row, scored A–D.

### 4. Confirm deliverability (optional, slower)
```bash
node enrich.cjs --in examples/companies.csv --out enriched.csv --smtp
```
This actually probes each mail server. **Note:** needs outbound port 25 (works on most VPS/servers; some home ISPs block it).

---

**That's it.** No signup, no API key, no monthly bill. Full details in `README.md`.
