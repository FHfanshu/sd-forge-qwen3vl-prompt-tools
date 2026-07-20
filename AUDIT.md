# Active Audit Log

Historical migration implementation remains available on branch `kt` and tag
`kt-final`. The concise archive index is in
`docs/archive/audit-archive-2026-07-19.md`; detailed working notes are
local-only under `docs/archive/`.

## 2026-07-20 Local Runtime Feedback And Agent Tool Enforcement

- Root cause: on-demand llama.cpp startup blocked on its readiness probe while
  the frontend exposed only the generic submitting state. Separately, named
  entity background questions used provider `tool_choice=auto`; the runtime
  enforced `edit_prompt` for mutations but had no equivalent lookup invariant,
  so Gemma4 could legally emit an unverified text answer without using tools.
- Added a sanitized local runtime status endpoint exposing only
  `idle/loading/ready/failed` and elapsed seconds. The chat working indicator now
  reports local model startup and weight loading, and cancellation/failure clears
  the watcher without leaving the composer disabled.
- Added a background-lookup gate for explicit named-entity/background questions.
  The provider is forced through `search_resources(kind=style)` and
  `inspect_resource(kind=style)` because local Forge styles are authoritative for
  character trigger words. It falls back to Danbooru only when no style matches.
  Unverified streaming text is hidden, successful inspection restores normal
  auto selection, and bounded corrective retries end in a visible failure rather
  than a fabricated answer.
- Fixed chat/settings interaction by preserving desktop/tablet floating windows,
  bringing chat to the front when its composer receives focus, and retaining the
  separate-view/focus-restoration behavior on phone layouts.
- Live Forge read-only verification returned exactly one local style for
  `moqing`; inspecting its logical ID returned the configured positive and
  negative trigger templates without exposing a filesystem path.
- Re-audited mobile acceptance chronology before changing layout code. The exact
  full-screen phone assertions dated to July 17, while the July 20 profile
  settings refactor explicitly replaced that behavior with persisted floating
  mobile layouts and added a CSS regression guard. Updated the stale mock-host
  E2E assertions to require an in-viewport, non-full-screen settings window;
  production CSS was not reverted to satisfy the obsolete expectation.
- Changed files include `backend/prompt_agent/{app,contracts,local_runtime}.py`,
  provider adapters, `frontend/src/agent/{agent-runtime,controller}.ts`,
  `frontend/src/{profile-api,providers/proxy-stream}.ts`, runtime/UI components,
  i18n, and focused Python/frontend tests.
- Verification: 88 Python tests and 144 frontend tests passed. Svelte check
  reported 0 errors and 0 warnings. The Vite build regenerated
  `javascript/prompt_agent_90_ui.js` at 756,574 raw bytes and 218,425 gzip
  bytes, within budget. All six Prompt Agent browser scripts passed `node
  --check`; all seven mock-host Playwright scenarios passed; `git diff --check`
  reported only existing line-ending warnings.

## 2026-07-19 Phase 9 Runtime Removal

- Removed the managed KT/Terrarium sidecar, installer/configuration, old
  provider runtime, frontend KT client, runtime controller, lease/claim paths,
  session ownership, queue/branch/replay runtime, and their contract tests.
- Removed the tracked legacy session sample and deleted local ignored sidecar
  state, SQLite assistant sessions, coverage reports, Playwright artifacts, and
  stale Python bytecode. The active tree does not contain `.loom`.
- Rewrote the active README and session design around Prompt Agent, Python
  profile/provider authority, Pi frontend state, and IndexedDB sessions.
  Historical migration documents are explicitly labeled as historical.
- Removed stale sidecar, queue, branch, and runtime-retry translations and the
  unused archived SSE fixture. The required KohakuTerrarium attribution remains
  because `LICENSE` and `test_kohaku_attribution.py` require it.
- Profile public projections expose configuration flags instead of local paths;
  local path and API key drafts remain component-local until explicit Save.
- Verification: Python compile and 39 Python tests passed before the audit
  archive split; 10 standalone browser contracts passed; Svelte check passed
  with 0 errors and warnings; focused profile/i18n frontend tests passed 21
  tests; mock Playwright passed all 6 scenarios. The full gates are rerun after
  this archive split and generated-bundle rebuild.

## 2026-07-20 Phases 3-9 Completion Audit

- Completed the single Pi runtime lifecycle, provider proxy, provider adapters,
  Forge Agent Tools, Python profile authority, and IndexedDB v2 session work.
- Root cause of the final Phase 6 failures: `ProfileAuthority` accepted only
  `Path` despite normal path-like callers, catalog output trusted extra internal
  fields, and server validation checked generation/patch containers without
  validating every nested value.
- Changed `backend/prompt_agent/profiles.py`,
  `backend/prompt_agent/forge_tools.py`, `backend/prompt_agent/app.py`, and
  `tests/test_forge_tools.py` to accept path-like roots, allowlist catalog
  projections, validate nested patch/generation values, and prevent upstream
  teacher error text from crossing the public API boundary.
- Added `/prompt-agent/api/forge-tools/validate`; the active browser host now
  revalidates prompt and generation tool arguments in Python before reading or
  mutating Forge DOM. Focused API and browser-host tests cover this boundary.
- Added effective provider capability projection in
  `frontend/src/providers/profile-capabilities.ts`. Unsupported capabilities
  are visible in profile settings, and `llama-once` cannot become the active or
  teacher agent profile while remaining available for local session/naming use.
- Added a real browser refresh regression: partial assistant content is durably
  stored, becomes interrupted after reload, a persisted stale tool call does not
  execute, no provider request resumes, and the next submission succeeds.
- Cleanup removed the orphaned `kohaku_loom/tool_args.py`, five unused UI export
  stubs, a duplicate test dependency, empty migration directories, and local
  bytecode/coverage/Playwright artifacts. Legal attribution and rollback/audit
  documents remain intentionally distributed.
- Regenerated `javascript/kohaku_loom_90_ui.js` from `frontend/`; raw size is
  754,078 bytes and gzip size is 215,832 bytes, within the configured budget.
- `python -m compileall -q backend kohaku_loom scripts install.py tools` and
  `python -m unittest discover -s tests`: 74 tests passed before the final
  active-tree marker guard; the focused architecture suite then passed 3 tests.
- `python tools/test_runner.py --max-skips 20`: 74 tests passed with 0 skipped.
- Python branch coverage gate: 76%, above the required 70%.
- Frontend Svelte check: 0 errors and 0 warnings. Frontend coverage: 120 tests
  passed across 20 files with 87.22% statement coverage.
- Frontend build, bundle budget, seven mock-host Playwright scenarios, and
  `node --check javascript/kohaku_loom*.js` passed.
- Active-tree dependency audit found no archived sidecar, lease, ownership,
  queue, branch, replay, or provider-runtime execution path. An API-registration
  startup sentinel reported `.loom` absent before and after registration. A
  permanent architecture test now enforces the archived-runtime marker budget.
- Remaining risk: real Forge/provider/local-model smoke tests require external
  running services and credentials. Phase 10 naming remains blocked by the
  licensing decision and remote repository administration.

## 2026-07-20 Frontend Prompt Agent Naming And Storage Migration

- Root cause: the active hand-authored frontend still exposed archived Kohaku
  Loom branding through bridge globals, DOM hooks, CSS prefixes, i18n routes,
  UI labels, and persisted localStorage keys even after the runtime and API had
  moved to Prompt Agent.
- Changed the scoped frontend source and tests, `frontend/index.html`,
  `frontend/tailwind.config.ts`, and `frontend/README.md` to use Prompt Agent
  identifiers, including `PromptAgentActionHandlers`, `PromptAgentStore`,
  `prompt-agent-host`, `prompt-agent-ui`, `data-prompt-agent-*`, `pa-*`, and
  `/prompt-agent/api/i18n`.
- Added `frontend/src/storage-migrations.ts` and
  `frontend/tests/storage-migrations.test.ts`. Reads prefer canonical Prompt
  Agent keys and migrate each legacy value once; writes and removals touch only
  canonical keys and remove stale legacy values. No secrets or raw user content
  were added to the audit.
- Generated browser output under `javascript/` was not edited or rebuilt. The
  existing unrelated worktree changes outside this scoped frontend increment
  were preserved.
- Verification: pinned Node `22.17.0` / pnpm `10.12.4` returned the expected
  versions; `pnpm run check` found 0 errors and 0 warnings; `pnpm run test`
  passed 21 files and 123 tests; scoped `git diff --check` passed; scoped
  legacy-identifier search found only the six intentional compatibility keys in
  `LEGACY_STORAGE_KEYS`.
- Residual risk: the roadmap's full distributed naming migration remains gated
  by the licensing decision; the six old storage key literals must remain until
  their compatibility migration window is intentionally retired.

## 2026-07-20 Phase 10 Technical Naming Completion

- Completed the active technical rename to Prompt Agent across the Python
  package and Forge script, `/prompt-agent/api` routes, browser filenames and
  namespace, bridge names, browser events, DOM/data identifiers, `pa-*` CSS,
  package metadata, generated asset, tests, and active documentation.
- Removed the runtime `window.kohakuLoom` and `window.KohakuLoomSvelteUi`
  aliases. Shared browser state is authoritative only at
  `window.__SD_FORGE_NEO_PROMPT_AGENT__`; the generated UI is exposed as its
  `ui` property.
- Preserved shipped UI preferences through canonical-first, one-time migration
  of locale, layouts, launcher position, favorites, and recents. The old keys
  are isolated compatibility literals; all writes use Prompt Agent keys.
- Preserved the required visible KohakuTerrarium attribution and root license.
  Added `THIRD_PARTY_NOTICES.md` for KohakuTerrarium, Pi 0.74.2, and TypeBox
  1.1.24. The technical rename does not relicense the repository: release under
  Prompt Agent-only branding, an MIT relicensing, and remote repository rename
  remain gated by copyright permission or independent-licensing evidence.
- Added an active-tree architecture guard against archived technical names,
  with narrow exceptions for historical/legal records, negative assertions,
  and one-time storage migration constants.
- Startup verification found that `prompt_agent/reference_image.py` still
  imported a deleted assistant-model constant. Removed the dead fallback and
  added import, reference-image message, API registration, and `.loom`
  non-creation regression coverage.
- Verification: Python compile passed; 79 tests passed with 0 skips; Python
  branch coverage was 73%, above the 70% gate. Svelte check reported 0 errors
  and 0 warnings; frontend coverage passed 123 tests across 21 files at 87.33%
  statements. Eleven root browser contracts and seven Chromium Playwright
  scenarios passed.
- Vite generated `javascript/prompt_agent_90_ui.js` at 755,214 raw bytes and
  216,261 gzip bytes, within budget. All six Prompt Agent browser scripts passed
  `node --check`; `git diff --check` reported only line-ending warnings.
- The isolated Forge registration sentinel reported
  `before=False after=False callback=prompt-agent-api callbacks=1`.
- Residual risk: real Forge, provider, and local-model smoke tests still require
  running external services and credentials. GitHub repository rename, default
  branch changes, and old remote branch handling require repository admin
  access. No migration change has been committed or pushed.

## 2026-07-20 Minimalist Frontend Refresh

- Root cause: `frontend/src/styles.css` carried two competing visual systems —
  a decorative glass/warm-tone layer and a later Forge-native override block —
  defining the same selectors twice, with hard-coded light/translucent colors
  hostile to dark themes and the file at the 1000-line source limit.
- Consolidated `styles.css` into a single token-first Forge-native stylesheet
  (1000 -> ~540 lines): all colors map to Gradio/Forge variables, one accent
  (`--primary-500`), removed dead rules for unused classes (legacy reasoning
  slider/popover, queue strip, risk pills, brand orb, profile quick/advanced
  cards, and similar), and merged the three responsive blocks.
- `selector-styles.css` now consumes shared radius/shadow tokens; no Svelte
  markup changes were required (verified every used `pa-*` class is styled).
- Changed files: `frontend/src/styles.css`, `frontend/src/selector-styles.css`,
  regenerated `javascript/prompt_agent_90_ui.js`.
- Verification: `pnpm run check` 0 errors/0 warnings; `pnpm run test` 123
  passed across 21 files (includes the two CSS-string assertions);
  `pnpm run build` succeeded (741 kB bundle); `node --check` passed for all
  Prompt Agent browser scripts; `python -m unittest discover -s tests` 79
  passed. Light/dark Forge theme smoke check in a live UI remains a manual
  follow-up.

## 2026-07-20 Repository Hygiene

- Root cause: ignored Python bytecode, coverage data, frontend dependencies,
  package caches, and Playwright results had accumulated in the working tree;
  two detailed historical migration documents also duplicated history already
  retained by `kt`, `kt-final`, and the concise tracked archive.
- Removed local generated and test artifacts while preserving `data/`, which
  contains local profile and secret state. Kept all active source, runtime,
  build, and test directories.
- Changed `.gitignore`; stopped tracking `docs/KOHAKU_LOOM_MIGRATION.md` and
  `docs/audit-archive-2026-07-19-full.md` while retaining both local copies.
- Verification: `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s
  tests` passed 79 tests, the focused architecture suite passed 4 tests,
  staged and scoped `git diff --check` passed, and the final ignored-artifact
  dry run was empty outside the preserved local files. Standard `git gc`
  reduced loose-object storage from 12.60 MiB to 235 bytes without integrity
  errors.

## 2026-07-20 MIT Relicense And Attribution Cleanup

- Root cause: the active tree no longer ships the KT/Terrarium runtime, but
  root `LICENSE`, README, UI attribution, and `test_kohaku_attribution.py`
  still enforced KohakuTerrarium naming and visible attribution as a release
  gate.
- Decision: relicense the active product under MIT as repository owner; keep
  branch `kt` and tag `kt-final` as a frozen historical lesson without
  rewriting Git history.
- Changed `LICENSE` to MIT; rewrote `THIRD_PARTY_NOTICES.md` for Pi and TypeBox
  only; updated README, ROADMAP Phase 10, and `docs/kt-runtime-migration.md`
  licensing text; removed the Profile Settings "Powered by KohakuTerrarium"
  menu item; dropped `profiles.powered_by` locale strings; deleted
  `tests/test_kohaku_attribution.py` and its architecture allowlist entry.
- Verification: `python -m unittest tests.test_i18n tests.test_architecture -v`
  passed 10 tests; full `python -m unittest discover -s tests` passed 78 tests;
  frontend `pnpm install --frozen-lockfile`, `pnpm run build`, and
  `pnpm run check` passed (0 errors/warnings; regenerated
  `javascript/prompt_agent_90_ui.js`); `node --check` passed for browser
  scripts. Active tree no longer contains KohakuTerrarium attribution strings
  in LICENSE, README, Profile Settings, or locale catalogs. Branch `kt` and tag
  `kt-final` were intentionally kept.

## 2026-07-20 Docs And Tools Layout Cleanup

- Root cause: active docs mixed product guides with KT migration history, and a
  one-file `tools/` package only held the skip-budget test runner.
- Moved historical docs into `docs/archive/` with a short index README; kept
  active `docs/SESSION_SYSTEM_DESIGN.md` and `docs/DANBOORU_TAGS_AGENT.md`.
  Local-only detailed archives remain gitignored under `docs/archive/`.
- Moved `tools/test_runner.py` to `tests/run_suite.py` and removed empty
  `tools/`; updated README, CI compile/test commands, ROADMAP phase-1 paths,
  and architecture historical-file allowlist.
- Verification: `python -m compileall -q backend prompt_agent scripts install.py
  tests` passed; `python tests/run_suite.py --max-skips 20` passed 78 tests with
  0 skipped; `python -m unittest tests.test_architecture -v` passed 4 tests.

## 2026-07-20 README Tools List And Partial CI

- Updated README with layout, the 12 agent-exposed Forge tools, and tiered
  local verification commands (fast / frontend / full).
- CI path filters: backend jobs skip when only frontend changes and vice versa.
  PR backend matrix is Python 3.12 only; main/manual keep 3.11–3.13. Coverage
  artifacts stay main/manual. Browser-script syntax merged into the frontend
  job. Concurrency cancels superseded runs.

## 2026-07-20 Agent Tool Surface Revision

- Removed `ask_teacher` from the agent tool registry, Python validation names,
  forge-tools API execution path, and host dispatch (explicit rejection remains).
- Registered Danbooru tools already implemented by the resource host:
  `search_danbooru_tags`, `inspect_danbooru_tag`, `inspect_danbooru_tags`,
  `related_danbooru_tags`.
- Host `edit_prompt` / `edit_negative_prompt` now allow full `prompt` overwrite
  only when the current field is empty; non-empty fields require patches/diff.
- Updated Anima skill mix guidance, system prompt, README, ROADMAP Phase 6,
  and focused Python/frontend tool tests.
- Verification: `python -m unittest tests.test_forge_tools tests.test_architecture`
  passed 13 tests; frontend vitest 123 passed; `node --check javascript/prompt_agent.js`
  and `node --test tests/test_frontend_resources.js` passed; rebuilt
  `javascript/prompt_agent_90_ui.js`.

## 2026-07-20 Agent Tool Compression

- Reduced the model-visible surface from 15 tools to 9 without removing
  capabilities. Positive/negative prompt tools now share `field`; Forge
  resources share `kind`; single Danbooru inspection uses a one-item `names`
  array in the existing batch tool.
- Model and embedding catalogs route through the Python logical-ID projection;
  styles, wildcards, and LoRAs continue through the Forge resource API.
- Removed the now-unused browser forge-tools POST client and updated schemas,
  validation, host dispatch, docs, and regression tests.
- Verification: `python tests/run_suite.py --max-skips 20` passed 78 tests with
  0 skipped; frontend `pnpm run test` passed 123 tests and `pnpm run check`
  reported 0 errors/warnings; browser contracts passed 11 tests; all Prompt
  Agent scripts passed `node --check`; Vite build and bundle-size passed
  (740,340 raw / 213,867 gzip bytes).

## 2026-07-20 Installer Namespace And Forge Locale Recovery

- Installer root cause: the extension's `backend/__init__.py` made `backend` a
  regular package and shadowed Forge Neo's sibling `backend.args` while the
  extension installer was first on `sys.path`. Removed that marker so both
  trees participate in the `backend` namespace package.
- Locale root cause: the Svelte store fetched `/prompt-agent/api/i18n/locale`
  but discarded its parsed Forge locale. Initial host hints could therefore
  fall back to the browser language and remain English even when Forge used
  `zh_CN`.
- Applied Python locale metadata to `forgeLocale` during preload and after host
  locale events. Added regressions for namespace coexistence and Forge-locale
  precedence over an English browser locale.
- Verification: the real Forge venv ran `install.py` successfully;
  `python tests/run_suite.py --max-skips 20` passed 79 tests with 0 skipped;
  frontend Vitest passed 124 tests and Svelte check reported 0 errors/warnings;
  root browser contracts passed 11 tests; Vite build, `node --check`, and the
  bundle-size check passed (740,420 raw / 213,885 gzip bytes). The configured
  Playwright web-server command could not launch `pnpm@10` on Windows, so the
  same pinned Vite server was started explicitly and all 7 mock Chromium
  scenarios passed.

## 2026-07-20 Gemma 4 12B On-Demand Local Runtime

- Restored `llama-once` as a streaming Pi agent runtime without restoring the
  archived sidecar. Python now owns one loopback-only llama.cpp process while
  the frontend owns the complete agent turn and its tool loop.
- Added explicit turn start/stop boundaries so model calls before and after
  Forge tools reuse the same process. The process is terminated after the final
  reply, failure, abort, or stale interrupted turn by default. A profile toggle
  can keep it resident between replies instead.
- Added server-only MTP draft-model configuration and safe public configured
  flags. Model, mmproj, draft, and executable paths remain absent from browser
  profile responses and stream requests.
- Configured the local machine profile for Gemma 4 12B Q8, its BF16 mmproj and
  MTP draft model under `E:\AI\lmcpp`, with 16K context, full RTX 3090 offload,
  one slot, flash attention, prompt-cache disabled, and reply-end unloading.
- Corrected `E:\AI\lmcpp\start-server.bat` to use the installed mmproj and the
  current llama.cpp MTP flags while binding only to `127.0.0.1`.
- Real verification loaded Gemma on a dynamic loopback port, returned exactly
  `LOCAL_OK`, then reported `stopped: true`; the PID disappeared and GPU memory
  returned to approximately 1.69 GiB baseline. Python passed 82 tests with 0
  skipped; frontend Vitest passed 127 tests and Svelte check reported 0 errors
  or warnings. The generated bundle passed its size budget at 743,468 raw /
  214,508 gzip bytes; browser contracts passed 11 tests and mock Chromium E2E
  passed all 7 scenarios.

## 2026-07-20 Bugfix: Settings Selects Lost Styling

- Symptom: dropdowns/selects in the profile settings window were unusable
  after the minimalist refresh.
- Root cause: the `styles.css` consolidation removed legacy CSS variables
  (`--pa-border`, `--pa-input`, `--pa-ring`, `--pa-background`,
  `--pa-secondary-foreground`, `--pa-muted*`, `--pa-popover*`,
  `--pa-radius-sm`, and the shadcn-meaning `--pa-accent`) that
  `frontend/tailwind.config.ts` maps into Tailwind theme colors used by the
  shared UI primitives (`pa-border-input`, `pa-bg-background`,
  `pa-ring-ring`, etc.).
- Fix: restored every Tailwind-consumed token on the surface root and moved
  the refresh's primary-accent usages to a dedicated `--pa-focus` token to
  avoid the `--pa-accent` semantic collision.
- Regression coverage: new `frontend/tests/style-tokens.test.ts` asserts all
  Tailwind-consumed tokens stay defined in `styles.css`.
- Verification: `pnpm run test` 125 passed across 22 files; `pnpm run build`
  succeeded; `node --check` passed on the generated bundle; manually verified
  against the Vite mock host that the Runtime select changes value and the
  header DropdownMenu opens and renders correctly. The mock Playwright
  webServer script fails under the npm temporary-toolchain wrapper (env issue,
  unrelated to this fix).

## 2026-07-20 Profile Settings Refactor And Teacher Removal

- Root causes: narrow/mobile profile settings were forced into a full-viewport
  layout; controlled profile fields autosaved on every keystroke and normalized
  empty intermediate values back to hard-coded defaults; the retired two-model
  Teacher route and `teacher_mode` redaction field still crossed frontend and
  backend profile contracts.
- Added commit-on-change input/textarea wrappers so identity, endpoint,
  fallback endpoint, and numeric fields remain freely editable until commit.
  Empty required values revert with validation feedback; ordinary typing no
  longer sends one PATCH per keystroke.
- Mobile profile settings now use their persisted floating layout, remain
  draggable like the chat window, and keep resize disabled on narrow/mobile
  viewports. Removed the forced `inset: 0` full-screen CSS path and softened
  warning/tab/form visual hierarchy.
- Removed the Teacher route and `teacher_mode` end to end from frontend
  contracts, state adapter/store/API, profile settings, backend profile
  authority/migration/public contracts, active locale strings, mocks, and
  regression tests. Legacy JSON keys are ignored and disappear on normalized
  writeback; the main active profile remains the sole agent profile.
- Verification: Svelte check reported 0 errors and warnings; frontend Vitest
  passed 141 tests across 22 files; Python unittest passed 85 tests; Vite build
  regenerated `javascript/prompt_agent_90_ui.js` at 751.74 kB raw / 217.59 kB
  gzip; generated and boot scripts passed `node --check`.

## 2026-07-20 Bugfix: Agent Recovery And Edit Resend

- Symptoms: a failed Forge tool call ended the agent turn instead of letting the
  model inspect the error and retry, direct prompt-edit requests could finish
  with advice but no successful `edit_prompt`, and the Pi migration no longer
  exposed the previous user-message edit-and-resend workflow.
- Root causes: the browser controller marked tool errors as terminal, the
  runtime had no bounded completion guard for requested prompt mutations, and
  the migrated UI/session layer omitted transcript rewind and persisted-message
  suffix deletion.
- Fix: tool failures now remain in the single browser-owned Pi loop with a
  visible `retrying` state. Direct mutation requests receive at most two hidden
  corrective follow-ups until `edit_prompt` succeeds, then fail explicitly
  with `prompt_mutation_incomplete` instead of claiming success. Hidden control
  messages and superseded assistant replies are excluded from UI, snapshots,
  and persistence.
- Restored edit and resend by deleting the selected user message and all later
  records in one IndexedDB transaction, replacing the runtime transcript, and
  submitting the edited text and attachments. Cancel restores the pre-existing
  composer draft. Ordinary streaming snapshots retain earlier complete
  history; cleanup of superseded records only runs at correction and terminal
  persistence boundaries.
- Changed files: `frontend/src/agent/agent-runtime.ts`,
  `frontend/src/agent/controller.ts`, `frontend/src/agent/runtime-state.ts`,
  `frontend/src/components/Surface.svelte`,
  `frontend/src/components/WorkingIndicator.svelte`,
  `frontend/src/contracts.ts`, `frontend/src/sessions/repository.ts`,
  `frontend/src/styles.css`, `prompt_agent/i18n.py`, focused frontend tests, and
  rebuilt `javascript/prompt_agent_90_ui.js`.
- Regression coverage includes stale prompt-hash refresh and retry, bounded
  hidden mutation correction, explicit incomplete-mutation failure, transcript
  replacement, IndexedDB suffix deletion, stale snapshot cleanup, ordinary
  streaming-history retention, edit cancellation/draft preservation, and mock
  Chromium edit-and-resend, abort, and refresh interruption flows.
- Verification: `python -m unittest discover -s tests` passed 85 tests;
  frontend `pnpm run test` passed 143 tests across 24 files; focused frontend
  tests passed 61; `pnpm run check` reported 0 errors and two pre-existing
  settings-input warnings; Vite build and bundle-size passed at 752,538 raw /
  217,358 gzip bytes; all Prompt Agent browser scripts passed `node --check`;
  browser contracts passed 11 tests; final targeted Playwright passed all 3
  affected scenarios. The full mock suite passed 6 of 7; its remaining mobile
  settings-window offset assertion and the configured Windows web-server npm
  package-name error are unrelated to this agent-loop/message-history fix.

## 2026-07-20 Critical Acceptance Quality Gates

- Root cause: critical product behavior was distributed across ordinary tests
  without a revisioned source of truth, so stale high-level assertions could
  pressure production code to restore superseded behavior. Local verification
  also relied on manually assembled commands instead of a consistent affected
  versus delivery gate.
- Added `quality/acceptance.json`, shared Python/Vitest/Playwright acceptance
  helpers, expiring flaky-test waivers, and `tools/test_gate.py`. The registry
  governs 11 critical UI, session, agent/provider, local-runtime, security, and
  data-integrity requirements through 26 mapped test references. Affected mode
  warns and skips stale mappings; full mode rejects them. Intentional behavior
  changes explicitly bump the relevant requirement revision.
- Migrated critical tests to observable acceptance scenarios and replaced exact
  mobile geometry assumptions with viewport containment and floating-window
  semantics. Added focused gate self-tests and documented affected, full,
  release, and behavior-change workflows in the repository guidance.
- Verification exposed three gate-environment defects: Python subprocesses on
  Windows did not resolve the `npx.cmd` shim, Node 22 required JSON import
  attributes in the TypeScript helpers, and seven parallel cold Vite
  navigations exceeded the old 10-second Playwright ceiling before assertions
  ran. The gate now resolves Windows executable shims and reports missing tools
  as environment failures; helpers use valid JSON import attributes; the E2E
  ceiling is 30 seconds while all behavioral assertions remain unchanged.
- `python tools/test_gate.py affected` passed with a clean 11-requirement / 26-
  mapping preflight, 55 Python tests, Svelte check with 0 errors and warnings,
  56 focused frontend tests, and all 7 mock-host browser scenarios.
- `python tools/test_gate.py full` passed Python compilation, 93 Python tests,
  11 browser host contracts, Svelte check with 0 errors and warnings, 145
  frontend tests across 22 files, production build, bundle budget at 756,574
  raw / 218,425 gzip bytes, all 7 browser scenarios, and syntax checks for all
  6 Prompt Agent browser scripts.
