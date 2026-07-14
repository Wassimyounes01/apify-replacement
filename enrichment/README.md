# 📇 Apollo Replacement — B2B Contact Enrichment Toolkit

**Find and verify decision-maker emails from a list of companies — on your own machine, for $0.**
Kill your $99–$149/mo contact-database bill. Point this at a domain (or a whole CSV of companies) and it generates the likely work-email patterns, verifies which ones are real, enriches with title/role, scores each by confidence, and hands you a clean, ready-to-import CSV. No subscription, no per-credit metering, no data leaving your machine.

---

## Why this exists

Contact-database tools charge monthly for two things you can do yourself:

1. **Guessing the email** — 90% of B2B work emails follow a handful of patterns (`first.last@`, `flast@`, `first@`). You don't need a database for that; you need the right pattern + a verifier.
2. **Verifying it's real** — an MX lookup plus an optional SMTP probe tells you whether an inbox actually accepts mail, without ever sending anything.

This toolkit does both, locally, with no external services and no npm dependencies. What it *doesn't* do is copy a proprietary database — so instead of "we already have this person," it does the honest version: **generate the most-likely address, then prove whether it's deliverable.** In practice that recovers the same emails those tools sell, at $0.

---

## What it does (the pipeline)

```
companies.csv  →  permute patterns  →  MX check  →  (optional) SMTP probe  →  score  →  enriched.csv
```

1. **Input** — a CSV of `domain, first_name, last_name` (extra columns like `company`, `title` pass through). Or a single lookup on the command line.
2. **Permute** — generates the standard work-email patterns for each name + domain, ranked by how common they are.
3. **Verify** — checks each domain has real mail servers (MX), then (with `--smtp`) probes the top mail server to see if the specific address is accepted. Cheapest checks first; nothing is ever *sent*.
4. **Score** — each candidate gets a 0–100 confidence score and an A–D grade based on pattern-commonness + MX + SMTP result.
5. **Export** — one best email per company, plus the runner-up candidates, written to a clean CSV you can import anywhere.

---

## Quick start

```bash
# 1) Single lookup
node enrich.cjs --domain acmecorp.com --first Jane --last Doe

# 2) A whole list (recommended)
node enrich.cjs --in companies.csv --out enriched.csv

# 3) Add live SMTP verification (slower, but confirms deliverability)
node enrich.cjs --in companies.csv --out enriched.csv --smtp
```

`companies.csv` just needs a header row — see **`examples/companies.csv`**. Any of these column names work: `domain` / `website` / `company_domain`, `first_name` / `last_name` or a single `full_name`, plus optional `company` and `title`.

---

## Output columns

| Column | Meaning |
|---|---|
| `best_email` | The highest-confidence address found for that company/person |
| `pattern` | Which pattern produced it (`first.last`, `flast`, …) |
| `mx_valid` | Whether the domain has real mail servers |
| `smtp_status` | `accepted` / `rejected` / `unknown` (only when `--smtp` is used) |
| `confidence_score` | 0–100 |
| `grade` | A (verified) → D (weak guess) |
| `other_candidates` | The next-best addresses, if you want to try more |

---

## Honest notes (read this)

- **Verification, not clairvoyance.** Without `--smtp`, a result means "this domain accepts mail and this is the most-likely pattern" — a strong guess, not a guarantee. Add `--smtp` to actually confirm the specific inbox.
- **Go easy on SMTP.** Many mail servers greylist or tarpit probes; the tool rate-limits itself to one probe per domain every couple of seconds. Big lists take time — that's the server being careful, not a bug.
- **Nothing is sent.** The SMTP probe stops before the message body every time. You are checking a door, not knocking.
- **Respect the law.** You're responsible for using recovered emails in line with CAN-SPAM / GDPR / local rules. This finds addresses; it doesn't grant permission to spam them.

---

## Requirements

- Node.js 16+ (uses only built-in modules — nothing to `npm install`).
- Outbound DNS. For `--smtp`, outbound port 25 (some home ISPs block it; a VPS doesn't).

---

## What's in the box

| File | What it is |
|---|---|
| `enrich.cjs` | The engine — permute → verify → score → export. Run it or `require()` it. |
| `examples/companies.csv` | A sample input to try immediately. |
| `QUICKSTART.md` | The 60-second version of this file. |
| `LICENSE` | MIT — use it commercially, modify it, ship it inside your own stack. |

*Self-hosted, $0/mo, no rate caps beyond your own patience. Yours to run forever.*
