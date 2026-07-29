You are doing a senior-engineer code review of this repository, an internal
commercial real-estate asset-management platform (single firm, staff-only,
desktop web app).

STACK
- Frontend: Vite + React 18 + TypeScript + Tailwind, SPA in src/ (~50k LOC:
  pages/, components/, hooks/, lib/, reports/)
- Backend: Supabase managed Postgres. Schema is defined by the migrations in
  supabase/migrations/ (~126 files, applied in numeric order). Access control
  is enforced by Row Level Security policies in the database.
- Edge functions: 30 Deno/TypeScript functions in supabase/functions/
- Automation: PowerShell ops/loader scripts in scripts/
- External APIs: Anthropic, OpenAI, Voyage (embeddings), Resend
- Deploy: Vercel (frontend) + Supabase (edge functions)

RULES
- READ ONLY. Do not run, build, deploy, modify files, or call any external API.
- Ignore .env and any secrets. Do not print secret values even if you see them.
- Cite exact file paths and line numbers for every finding.
- If you are unsure whether something is a real bug, say so rather than guessing.

FIRST, read for context:
- CLAUDE.md (architecture, roles, RLS design, conventions)
- docs/PROJECT-STATUS.md

THEN review the code and produce a written report, ranked by severity
(Critical / High / Medium / Low), covering:

1. SECURITY (highest priority — this holds multi-tenant financial data)
   - Row Level Security: any table missing policies, or policies that can leak
     one property's / tenant's data to another user
   - Edge-function authentication and authorization; anything callable
     unauthenticated that shouldn't be
   - The custom tenant-portal auth flow
   - Service-role key exposure, secrets in client-shipped code, the anon-role
     posture described in CLAUDE.md
   - SQL injection, unsafe/unbounded user input in edge functions

2. CORRECTNESS BUGS
   - Data-integrity issues, wrong financial math (see src/lib/financials.ts and
     src/lib/waterfall.ts), edge cases, error handling, race conditions in the
     PowerShell loaders and edge functions

3. ARCHITECTURE
   - Duplication/coupling across the 30 edge functions and src/lib modules
   - Migration hygiene (duplicate numbers, drift between disk and prod)

4. PERFORMANCE
   - Postgres query/index problems, N+1 patterns, materialized-view usage
   - Frontend bundle size and unnecessary re-renders

5. MAINTAINABILITY
   - Type-safety holes (any, unchecked casts), dead code, test-coverage gaps

END WITH: a prioritized top-10 action list — each item one line with the
file path and the single most valuable change to make.
