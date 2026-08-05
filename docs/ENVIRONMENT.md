# Environment variable reference

Names only — never commit values. Updated 2026-08-05 from a full grep of
`import.meta.env` (frontend) and `Deno.env.get` (edge functions).

## Frontend (`.env`, Vite — these ship in the browser bundle)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | anon key (public by design; anon role has zero write privileges) |

Missing either ⇒ login page renders a clear banner and disables sign-in
(verified live 2026-08-04). These are the ONLY frontend env vars.

## Edge functions (Supabase function secrets — server-side only)

### Platform (auto-provided by Supabase)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

### Auth / gateway (`_shared/auth.ts`)
`SUPABASE_SECRET_KEY` (fallback), `EDGE_SERVICE_SECRET`, `ALLOWED_ORIGINS`

### AI providers
| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | all abstract/brief/ask/extract/memo/market/ppm/siteplan/ocr functions |
| `OPENAI_API_KEY` | QA fallback paths (abstract-verify/-ensemble/-discuss/-clause-verify, agreement-verify, pdf-extract OCR fallback) |
| `VOYAGE_API_KEY` | embeddings + rerank (doc-search, doc-ask, clause-search, pdf-extract) |

### Model / behavior overrides (all optional, sensible defaults in code)
`ABSTRACT_MODEL`, `ABSTRACT_MAX_TOKENS`, `ANTHROPIC_MODEL`, `ANSWER_MODEL`,
`BRIEF_MODEL`, `BRIEF_SEG_CONCURRENCY`, `COI_MODEL`, `IC_MEMO_MODEL`,
`MARKET_MODEL`, `OM_EXTRACT_MODEL`, `PARSE_MODEL`, `PDF_EXTRACT_MODEL`,
`PPM_DRAFT_MODEL`, `QA_MODEL`, `QA_OPENAI_MODEL`, `RERANK_MODEL`,
`SITEPLAN_MODEL`, `UW_EXTRACT_MODEL`, `VOYAGE_MODEL`,
`AUTO_APPLY_FIELDS`, `ENSEMBLE_AUTO_APPLY`

### pdf-extract tuning
`PDF_STORAGE_MAX_BYTES`, `PDF_PAGE_LIMIT`, `PDF_SEGMENT_PAGES`,
`PDF_LARGE_SEGMENT_PAGES`, `PDF_LARGE_BYTES`, `TEXT_CHUNK_CHARS`,
`TEXT_CHUNK_OVERLAP`, `MIN_CHARS_PER_PAGE`, `OCR_EMPTY_PAGE_CHARS`,
`MAX_REINDEX_PAGES`, `OCR_MODEL`, `OCR_MAX_PAGES`, `OCR_MAX_TOKENS`,
`OCR_PROVIDER`, `OCR_OPENAI_MODEL`

### Email (Resend) — BLOCKED until owner provisions (KI-2)
`RESEND_API_KEY`, `ANNOUNCEMENT_FROM`, `SERVICE_AGREEMENT_FROM`, `DIGEST_FROM`,
`DIGEST_RECIPIENTS`, `APP_URL`

### Google Drive ingest
`GOOGLE_SERVICE_ACCOUNT` (service-account JSON), `GOOGLE_DRIVE_FOLDER_ID`

## CI (GitHub Actions repo secrets)

| Variable | Purpose |
|---|---|
| `VERCEL_TOKEN` | preview + production deploys (org/project IDs are in ci.yml, not secret) |
