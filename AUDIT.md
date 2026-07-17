# Audit Log

## 2026-07-16 Svelte UI Cutover

- Svelte 5 is now the only assistant and Model Profiles renderer.
- Removed the browser-managed assistant loop, legacy session UI, duplicate
  attachment/reasoning helpers, legacy settings/model-catalog UI, and the
  accumulated root `style.css`.
- Retained filename-ordered browser scripts only for the Forge host bridge,
  prompt/resource tools, profile persistence, locale hints, and generated
  Svelte boot.
- Added browser-side image optimization and payload limits, frame-coalesced
  streaming updates, final-only Markdown rendering, localized tab-safe prompt
  targeting, and active KT risk-mode synchronization.

## 2026-07-09 Architecture Split

Goal: split oversized backend and browser files, keep files under 1000 lines, and lock the package DAG against circular imports.

### Backend Split

- Commit `71f4652` split `kohaku_loom/generic.py` into focused modules.
- `generic.py` is now a compatibility facade for existing imports.
- New low-level modules: `constants.py`, `utils.py`, `image_payloads.py`, `response_text.py`.
- Runtime/model modules: `model_paths.py`, `llama_runtime.py`.
- Assistant modules: `assistant_common.py`, `assistant_gemini.py`, `assistant_local.py`, `assistant.py`, `reference_image.py`.

### Browser Split

- Commit `7e98d28` split the browser assistant script into ordered files.
- `kohaku_loom.js`: core namespace, config, prompt patch tools.
- `kohaku_loom_assistant.js`: assistant parsing, markdown, streaming, tool loop.
- `kohaku_loom_boot.js`: UI creation, drag behavior, mobile pull-refresh guard, boot hooks.

### Constraints

- Single-file limit: 1000 lines.
- Python package imports must remain acyclic.
- Package modules must not import from `kohaku_loom.generic`; use focused modules directly.

### Verification Notes

- Backend import/unit check passed after the split: `python -m unittest discover -s tests`.
- Browser syntax check passed after the split: `node --check javascript/kohaku_loom*.js`.
- Local model directory confirmed present: `E:\AI\lmcpp\models\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF`.
- Local llama-server binary confirmed present: `E:\AI\lmcpp\llama.cpp\llama-server.exe`.
- Final unittest/compile/browser checks passed after all commits.
- Local Qwen one-shot assistant was exercised with `local-qwen-once` and returned `local qwen assistant ok` from source `one-shot-local-qwen`.
- Moyuu/Gemini route was exercised without a token and reached the remote API, which returned 401 `Invalid token`; live Gemini teacher inquiry requires a configured API key.

## 2026-07-09 Local Qwen Teacher Redaction

- Gemini teacher mode now defaults to local Qwen redaction before remote calls.
- Browser attachments no longer go directly to Gemini in the default mode; local Qwen VLM analyzes/redacts first.
- `teacher_mode=regex` remains available as an advanced fallback for placeholder-only redaction.
- Default local VLM preset is `Qwen3.5 破限版 9B` to match the local testing model path.

## 2026-07-09 Ask Teacher Tool

- Added `ask_teacher` to the assistant tool schema for local Qwen-to-Gemini teacher consultation.
- Added `/kohaku-loom/ask-teacher`; teacher requests force `teacher_mode=regex` and disable Gemini-side tools to avoid recursion.
- Browser tool execution now posts sanitized `question` / `context` to the teacher endpoint and returns the result to the agent loop.

## 2026-07-17 Frontend Transition and Viewport Verification

- Root causes addressed: the architecture line-limit scan included ignored frontend coverage HTML; mobile profile settings were constrained to a desktop-style inset; the launcher/session transition needed to preserve the submitted payload while session creation completed.
- Changed `tests/test_architecture.py`, `frontend/src/components/Surface.svelte`, `frontend/src/styles.css`, and regenerated `javascript/kohaku_loom_90_ui.js`.
- `python -m unittest discover -s tests`: 207 passed, 20 skipped.
- `python tools/test_runner.py --max-skips 20`: 207 passed, 20 skipped; skip budget passed.
- Python coverage: 71% line coverage; `--fail-under=70` passed.
- Frontend checks: 79 tests passed with 79.58% lines, 69% branches, and 66.27% functions; all configured thresholds passed.
- Svelte check, production build, bundle-size check, browser-script syntax checks, and 4 Chromium E2E tests passed.

## 2026-07-17 Active Session Recovery and CI Audit

- Symptom: the first composer submission could fail with HTTP 409 and
  `{"detail":"A Loom session is already active"}`, leaving the send path unusable.
- Root cause: the browser runtime could lose its in-memory session id after a
  reload/remount while the sidecar still owned an active session. The client then
  tried to open a duplicate session. A launcher-created fresh session could also
  race an immediate composer submission.
- Fix: `frontend/src/runtime-controller.ts` now adopts the sidecar's active
  session before opening a new one and re-checks restored run state before
  starting a turn. `frontend/src/components/Surface.svelte` serializes launcher
  session creation with submission while preserving text entered during that
  transition.
- Regression coverage: runtime and surface tests cover active-session adoption,
  the absence of a duplicate `/sessions/open`, and immediate send during launcher
  session creation. Profile settings tests now reset locale and portal body state
  so the suite is repeatable rather than order-dependent.
- Frontend CI: 79 unit tests passed; line/statement coverage was 79.73%, branch
  coverage 68.94%, and function coverage 66.27%. Svelte check reported 0 errors
  and 0 warnings. Vite built 4,012 modules, the bundle-size check passed at
  162,383 bytes, all 8 browser scripts passed syntax checks, and 4 Chromium E2E
  tests passed.
- Backend CI: Python 3.11, 3.12, and 3.13 each passed 207 tests with 20 expected
  skips for the separately isolated KohakuTerrarium contract. Python 3.12 line
  coverage was 71%, above the 70% threshold.
- Dependency audit: PyPI stable KohakuTerrarium did not expose the capability
  level required by the contract tests. `requirements-kt-test.txt` now pins the
  known working upstream commit `f22b739d19785b9a065ac839a83eda457daba030`;
  the isolated required-KT job passed all 20 tests with 0 skips.
- Toolchain audit: the installed default Node/pnpm versions do not match the
  repository's Node 22/pnpm 10 engine declaration, so frontend verification used
  Node 22.17.0 explicitly. Source diffs pass `git diff --check`; the regenerated
  Vite bundle retains a generated line-2 whitespace warning and was not edited by
  hand.

## 2026-07-17 Long-Term Roadmap Governance

- Root issue: repository architecture and test rules were defined, but agents had
  no product-level execution order or measurable completion standard centered on
  user experience, performance, and stability.
- Added `ROADMAP.md` with product boundaries, agent decision rules, continuous
  quality gates, current CI budgets, measurement requirements, phased workstreams,
  exit criteria, work-intake questions, and a definition of done.
- Updated `AGENTS.md` to make the roadmap mandatory for non-trivial planning and
  to prioritize user experience, stability/data integrity, performance,
  maintainability, and only then new capability, while keeping security and
  privacy invariant.
- Verification: `python -m unittest tests.test_architecture` passed 3 tests;
  `ROADMAP.md` is 450 lines; the three changed documentation files passed a
  trailing-whitespace scan. Full-worktree `git diff --check` still reports the
  pre-existing generated `javascript/kohaku_loom_90_ui.js` line-2 warning noted
  above. No runtime source or generated frontend output changed, so broader
  application suites were not required for this documentation-only update.

## 2026-07-17 Composer, Runtime Isolation, and Lifecycle Recovery

- Composer symptom: the focused textarea showed a second border/outline outside
  the rounded composer shell. The cause was the textarea's independent focus
  styling combined with visible overflow. `frontend/src/styles.css` now keeps
  focus styling on the outer shell, removes the textarea outline/border/shadow,
  and clips all composer controls inside one rounded form. `frontend/tests/surface.test.ts`
  covers containment, and the rebuilt `javascript/kohaku_loom_90_ui.js` was
  verified against the live Forge DOM.
- Sidecar installation symptom: Forge's global `--uv` hook rewrote managed
  sidecar `pip` subprocesses and a broad reinstall attempted to replace locked
  compiled files in the active Forge environment. `kohaku_loom/sidecar_manager.py`
  now bypasses the hook through the original subprocess runner, serializes
  Windows installations with `.loom/runtime/install.lock`, pins the audited
  KohakuTerrarium commit, uses `--no-deps`, and reports actionable access-denied
  recovery instructions. `tests/test_loom_runtime.py` covers the hook bypass,
  pinning, lock diagnostics, and install command.
- Lifecycle symptom: malformed bridge claims were converted to `{}` and treated
  as successful leases; ownership loss during approval did not cancel an
  accepted turn; teardown could race a late bridge claim and start `/turns`.
  `frontend/src/runtime-controller.ts` now validates lease records, cancels the
  accepted turn on lease loss, and checks disposal before submitting. Focused
  regression coverage is in `frontend/tests/runtime-controller.test.ts`.
- Runtime state after repair: `.loom/runtime/runtime-lock.json` is ready and
  pinned to commit `f22b739d19785b9a065ac839a83eda457daba030`; managed-sidecar
  and main-Forge `lxml` imports both succeeded while Forge remained running.
- Verification: `python -m unittest discover -s tests` passed 215 tests with 20
  expected skips; `.loom/venv/Scripts/python.exe tools/test_runner.py
  --require-kt --max-skips 0` passed 215 tests with 0 skips; `svelte-check`
  passed with 0 errors and 0 warnings; Vitest passed 84 tests; the Vite build
  transformed 4,014 modules and produced a 582,660-byte bundle; bundle-size
  reported 163,843 gzip bytes; all 4 Chromium E2E tests passed; browser-script
  syntax checks passed; and `git diff --check` reported only the known generated
  bundle line-2 whitespace warning.
