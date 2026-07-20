from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
REGISTRY_PATH = ROOT / "quality" / "acceptance.json"
WAIVERS_PATH = ROOT / "quality" / "waivers.json"
ACCEPTANCE_DOC = ROOT / "quality" / "ACCEPTANCE.md"
REFERENCE_RE = re.compile(r"^(?P<id>[A-Z][A-Z0-9-]*-\d{3})@(?P<revision>[1-9]\d*)$")
PYTHON_MAPPING_RE = re.compile(r'@acceptance\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)')
TYPESCRIPT_MAPPING_RE = re.compile(r'acceptance(?:Test|Evidence)\(\s*"([^"]+)"\s*,\s*"([^"]+)"')
EXACT_E2E_PIXEL_RE = re.compile(r"expect\([^\n]*(?:\.x|\.y|\.width|\.height)\)\.toBe\(\d+\)")
AREAS = {"ui", "session", "agent", "provider", "lifecycle", "security", "data"}
MANAGED_TEST_FILES = {
    "tests/test_forge_tools.py",
    "tests/test_local_runtime.py",
    "tests/test_prompt_agent_api.py",
    "tests/test_prompt_agent_provider_adapters.py",
    "tests/test_security_boundaries.py",
    "frontend/tests/agent-runtime.test.ts",
    "frontend/tests/prompt-agent-controller.test.ts",
    "frontend/tests/surface.test.ts",
    "frontend/tests/e2e/mock-host.spec.ts",
}


@dataclass(frozen=True)
class Mapping:
    path: str
    reference: str
    scenarios: frozenset[str]

    @property
    def requirement_id(self) -> str:
        match = REFERENCE_RE.fullmatch(self.reference)
        return match.group("id") if match else ""

    @property
    def revision(self) -> int:
        match = REFERENCE_RE.fullmatch(self.reference)
        return int(match.group("revision")) if match else 0


@dataclass
class PreflightResult:
    requirements: dict[str, dict[str, Any]]
    mappings: list[Mapping]
    warnings: list[str]
    errors: list[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run acceptance-aware Prompt Agent test gates without making ordinary unit tests heavyweight."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight", help="Validate critical acceptance metadata and mappings.")
    preflight.add_argument("--mode", choices=("affected", "full"), default="affected")
    subparsers.add_parser("affected", help="Run acceptance preflight and tests affected by the current worktree diff.")
    subparsers.add_parser("full", help="Run the complete local delivery gate.")
    release = subparsers.add_parser("release", help="Run the full gate plus coverage and real-Forge evidence.")
    release.add_argument("--allow-missing-forge", action="store_true")
    behavior = subparsers.add_parser("behavior-change", help="Intentionally bump one acceptance revision.")
    behavior.add_argument("requirement_id")
    behavior.add_argument("--bump", action="store_true", help="Increment the revision and regenerate the Markdown table.")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read {path.relative_to(ROOT)}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def scan_mappings() -> list[Mapping]:
    result: list[Mapping] = []
    paths = [*sorted((ROOT / "tests").glob("test_*.py")), *sorted((FRONTEND / "tests").rglob("*.ts"))]
    for path in paths:
        relative = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8")
        pattern = PYTHON_MAPPING_RE if path.suffix == ".py" else TYPESCRIPT_MAPPING_RE
        for reference, scenarios in pattern.findall(text):
            result.append(Mapping(relative, reference, frozenset(split_scenarios(scenarios))))
    return result


def split_scenarios(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def validate_preflight(mode: str) -> PreflightResult:
    warnings: list[str] = []
    errors: list[str] = []
    try:
        registry = load_json(REGISTRY_PATH)
        waiver_payload = load_json(WAIVERS_PATH)
    except ValueError as error:
        return PreflightResult({}, [], [], [str(error)])
    entries = registry.get("requirements")
    if registry.get("version") != 1 or not isinstance(entries, list):
        errors.append("quality/acceptance.json must have version=1 and a requirements array")
        entries = []
    requirements: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(entries):
        prefix = f"requirement[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} must be an object")
            continue
        requirement_id = item.get("id")
        revision = item.get("revision")
        if not isinstance(requirement_id, str) or not REFERENCE_RE.fullmatch(f"{requirement_id}@1"):
            errors.append(f"{prefix}.id is invalid")
            continue
        if requirement_id in requirements:
            errors.append(f"duplicate requirement ID: {requirement_id}")
            continue
        if not isinstance(revision, int) or revision < 1:
            errors.append(f"{requirement_id}.revision must be a positive integer")
        if item.get("area") not in AREAS:
            errors.append(f"{requirement_id}.area must be one of {sorted(AREAS)}")
        for field in ("title", "assertion_policy"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                errors.append(f"{requirement_id}.{field} must be non-empty text")
        for field in ("acceptance", "required_scenarios", "paths"):
            values = item.get(field)
            if not isinstance(values, list) or not values or not all(isinstance(value, str) and value.strip() for value in values):
                errors.append(f"{requirement_id}.{field} must be a non-empty string array")
        requirements[requirement_id] = item

    mappings = scan_mappings()
    mapped_files = {mapping.path for mapping in mappings}
    for path in sorted(MANAGED_TEST_FILES - mapped_files):
        errors.append(f"managed acceptance test file has no acceptance mapping: {path}")
    covered: dict[str, set[str]] = {requirement_id: set() for requirement_id in requirements}
    for mapping in mappings:
        issue = mapping_issue(mapping, requirements, mode)
        if issue:
            level, message = issue
            (warnings if level == "warning" else errors).append(message)
            continue
        covered[mapping.requirement_id].update(mapping.scenarios)
    for requirement_id, requirement in requirements.items():
        missing = set(requirement.get("required_scenarios", [])) - covered[requirement_id]
        if missing:
            errors.append(f"{requirement_id}: required scenarios have no mapped test: {', '.join(sorted(missing))}")

    validate_waivers(waiver_payload, mode, warnings, errors)
    validate_assertion_policy(errors)
    expected_doc = render_acceptance_table(requirements.values())
    current_doc = extract_acceptance_table(ACCEPTANCE_DOC.read_text(encoding="utf-8")) if ACCEPTANCE_DOC.exists() else ""
    if current_doc != expected_doc:
        errors.append("quality/ACCEPTANCE.md table is stale; run behavior-change --bump or regenerate it")
    return PreflightResult(requirements, mappings, warnings, errors)


def validate_waivers(payload: dict[str, Any], mode: str, warnings: list[str], errors: list[str]) -> None:
    waivers = payload.get("waivers")
    if payload.get("version") != 1 or not isinstance(waivers, list):
        errors.append("quality/waivers.json must have version=1 and a waivers array")
        return
    today = dt.date.today()
    for index, waiver in enumerate(waivers):
        if not isinstance(waiver, dict):
            errors.append(f"waiver[{index}] must be an object")
            continue
        missing = [field for field in ("test", "owner", "reason", "created", "expires") if not waiver.get(field)]
        if missing:
            errors.append(f"waiver[{index}] missing fields: {', '.join(missing)}")
            continue
        try:
            created = dt.date.fromisoformat(str(waiver["created"]))
            expires = dt.date.fromisoformat(str(waiver["expires"]))
        except ValueError:
            errors.append(f"waiver[{index}] dates must use YYYY-MM-DD")
            continue
        if expires < created or (expires - created).days > 14:
            errors.append(f"waiver[{index}] exceeds the 14-day limit")
        if expires < today:
            message = f"waiver expired for {waiver['test']} on {expires.isoformat()}"
            (warnings if mode == "affected" else errors).append(message)
        else:
            warnings.append(
                f"active flaky-test waiver for {waiver['test']} owned by {waiver['owner']} until {expires.isoformat()}"
            )


def validate_assertion_policy(errors: list[str]) -> None:
    for path in sorted((FRONTEND / "tests" / "e2e").glob("*.spec.ts")):
        text = path.read_text(encoding="utf-8")
        for match in EXACT_E2E_PIXEL_RE.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            errors.append(
                f"{path.relative_to(ROOT).as_posix()}:{line}: exact E2E pixel assertion is not allowed; "
                "use semantic viewport/floating helpers or add an explicit registry acceptance"
            )


def render_acceptance_table(requirements: Iterable[dict[str, Any]]) -> str:
    lines = [
        "| Requirement | Rev | Area | Title | Required scenarios |",
        "| --- | ---: | --- | --- | --- |",
    ]
    for item in sorted(requirements, key=lambda value: value["id"]):
        scenarios = ", ".join(item["required_scenarios"])
        lines.append(f"| {item['id']} | {item['revision']} | {item['area']} | {item['title']} | {scenarios} |")
    return "\n".join(lines)


def extract_acceptance_table(text: str) -> str:
    start = "<!-- acceptance-table:start -->"
    end = "<!-- acceptance-table:end -->"
    if start not in text or end not in text:
        return ""
    return text.split(start, 1)[1].split(end, 1)[0].strip()


def update_acceptance_doc(requirements: Iterable[dict[str, Any]]) -> None:
    text = ACCEPTANCE_DOC.read_text(encoding="utf-8")
    start = "<!-- acceptance-table:start -->"
    end = "<!-- acceptance-table:end -->"
    before, rest = text.split(start, 1)
    _, after = rest.split(end, 1)
    table = render_acceptance_table(requirements)
    ACCEPTANCE_DOC.write_text(f"{before}{start}\n{table}\n{end}{after}", encoding="utf-8")


def print_preflight(result: PreflightResult, mode: str) -> int:
    for warning in result.warnings:
        print(f"WARNING [stale/flaky acceptance]: {warning}")
    for error in result.errors:
        print(f"ERROR [acceptance preflight]: {error}", file=sys.stderr)
    print(
        f"Acceptance preflight ({mode}): {len(result.requirements)} requirements, "
        f"{len(result.mappings)} mappings, {len(result.warnings)} warnings, {len(result.errors)} errors"
    )
    return 1 if result.errors else 0


def changed_files() -> list[str]:
    tracked = git_lines("diff", "--name-only", "HEAD")
    untracked = git_lines("ls-files", "--others", "--exclude-standard")
    return sorted(set(tracked + untracked))


def git_lines(*args: str) -> list[str]:
    completed = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "git command failed")
    return [line.strip().replace("\\", "/") for line in completed.stdout.splitlines() if line.strip()]


def matches_any(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def impacted_requirements(result: PreflightResult, files: list[str]) -> set[str]:
    return {
        requirement_id
        for requirement_id, requirement in result.requirements.items()
        if any(matches_any(path, requirement["paths"]) for path in files)
    }


def run_affected(result: PreflightResult) -> int:
    files = changed_files()
    if not files:
        print("No worktree changes detected; acceptance preflight is complete.")
        return 0
    impacted = impacted_requirements(result, files)
    mapped_tests = {
        mapping.path for mapping in result.mappings if mapping.requirement_id in impacted
    }
    print(f"Changed files: {len(files)}")
    print(f"Affected requirements: {', '.join(sorted(impacted)) or 'none'}")
    print(f"Mapped acceptance test files: {', '.join(sorted(mapped_tests)) or 'none'}")
    env = {**os.environ, "PROMPT_AGENT_TEST_MODE": "affected"}
    env["npm_package_manager"] = ""
    python_tests = sorted(path for path in mapped_tests if path.startswith("tests/") and path.endswith(".py"))
    frontend_tests = sorted(path.removeprefix("frontend/") for path in mapped_tests if path.startswith("frontend/tests/") and path.endswith(".test.ts"))
    e2e_tests = sorted(path.removeprefix("frontend/") for path in mapped_tests if "/e2e/" in path and path.endswith(".spec.ts"))
    commands: list[tuple[str, list[str], Path, str]] = []
    if python_tests:
        modules = [path[:-3].replace("/", ".") for path in python_tests]
        commands.append(("affected Python tests", [sys.executable, "-m", "unittest", *modules], ROOT, "implementation regression"))
    elif any(path.startswith(("backend/", "prompt_agent/", "scripts/")) for path in files):
        commands.append(("Python tests", [sys.executable, "tests/run_suite.py", "--max-skips", "20"], ROOT, "implementation regression"))
    if any(path.startswith("frontend/src/") for path in files):
        commands.append(("Svelte/type check", frontend_command("run", "check"), ROOT, "type or component contract"))
    if frontend_tests:
        commands.append(("affected frontend tests", frontend_command("exec", "vitest", "run", *frontend_tests), ROOT, "implementation regression"))
    elif any(path.startswith("frontend/") for path in files):
        commands.append(("frontend tests", frontend_command("run", "test"), ROOT, "implementation regression"))
    if e2e_tests:
        commands.append(("affected browser acceptance", frontend_command("exec", "playwright", "test", *e2e_tests), ROOT, "browser acceptance regression"))
    for label, command, cwd, classification in commands:
        if run_command(label, command, cwd, env, classification):
            return 1
    return 0


def frontend_command(*args: str) -> list[str]:
    if shutil.which("pnpm") and os.environ.get("CI"):
        return ["pnpm", "--dir", "frontend", *args]
    return [
        executable("npx"), "--yes", "--package", "node@22.17.0", "--package", "pnpm@10.12.4",
        "pnpm", "--dir", "frontend", *args,
    ]


def node_command(*args: str) -> list[str]:
    if shutil.which("node") and os.environ.get("CI"):
        return ["node", *args]
    return [executable("npx"), "--yes", "--package", "node@22.17.0", "node", *args]


def executable(name: str) -> str:
    candidates = [name]
    if os.name == "nt":
        candidates = [f"{name}.cmd", f"{name}.exe", name]
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return candidates[0]


def mapping_issue(mapping: Mapping, requirements: dict[str, dict[str, Any]], mode: str) -> tuple[str, str] | None:
    match = REFERENCE_RE.fullmatch(mapping.reference)
    if not match:
        return "error", f"{mapping.path}: invalid acceptance reference {mapping.reference}"
    requirement = requirements.get(mapping.requirement_id)
    if requirement is None:
        return "error", f"{mapping.path}: unknown acceptance requirement {mapping.reference}"
    if mapping.revision != requirement["revision"]:
        message = (
            f"{mapping.path}: stale acceptance {mapping.reference}; "
            f"current is {mapping.requirement_id}@{requirement['revision']}"
        )
        return ("warning" if mode == "affected" else "error"), message
    return None


def run_command(
    label: str,
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    classification: str,
) -> int:
    print(f"\n== {label} ==")
    print("Reproduce:", subprocess.list2cmdline(command))
    try:
        completed = subprocess.run(command, cwd=cwd, env=env, check=False)
    except FileNotFoundError:
        print(f"FAILED [environment]: executable not found: {command[0]}", file=sys.stderr)
        return 127
    if completed.returncode:
        print(f"FAILED [{classification}]: {label}", file=sys.stderr)
    return completed.returncode


def run_full(*, release: bool = False, allow_missing_forge: bool = False) -> int:
    env = {**os.environ, "PROMPT_AGENT_TEST_MODE": "full"}
    env["npm_package_manager"] = ""
    commands = [
        ("compile Python", [sys.executable, "-m", "compileall", "-q", "backend", "prompt_agent", "scripts", "install.py", "tests", "quality", "tools"], ROOT, "syntax/import regression"),
        ("Python tests", [sys.executable, "tests/run_suite.py", "--max-skips", "20"], ROOT, "implementation regression"),
        ("browser host contracts", node_command("--test", "tests/test_frontend_svelte_boot.js", "tests/test_frontend_resources.js", "tests/test_frontend_core_profiles.js"), ROOT, "browser host contract"),
        ("Svelte/type check", frontend_command("run", "check"), ROOT, "type or component contract"),
        ("frontend tests", frontend_command("run", "test"), ROOT, "implementation regression"),
        ("frontend build", frontend_command("run", "build"), ROOT, "generated bundle mismatch"),
        ("bundle budget", frontend_command("run", "bundle:size"), ROOT, "bundle budget"),
        ("mock-host browser acceptance", frontend_command("run", "test:e2e"), ROOT, "browser acceptance regression"),
    ]
    for label, command, cwd, classification in commands:
        if run_command(label, command, cwd, env, classification):
            return 1
    browser_scripts = sorted((ROOT / "javascript").glob("prompt_agent*.js"))
    for script in browser_scripts:
        if run_command(
            f"syntax {script.name}", node_command("--check", str(script.relative_to(ROOT))), ROOT, env, "generated/browser syntax"
        ):
            return 1
    if not release:
        return 0
    release_commands = [
        ("Python coverage", [sys.executable, "-m", "coverage", "run", "--branch", "-m", "unittest", "discover", "-s", "tests"], ROOT, "coverage regression"),
        ("Python coverage threshold", [sys.executable, "-m", "coverage", "report", "--fail-under=70"], ROOT, "coverage regression"),
        ("frontend coverage", frontend_command("run", "test:coverage"), ROOT, "coverage regression"),
    ]
    for label, command, cwd, classification in release_commands:
        if run_command(label, command, cwd, env, classification):
            return 1
    if not os.environ.get("FORGE_BASE_URL") and not allow_missing_forge:
        print(
            "FAILED [release environment]: FORGE_BASE_URL is missing. "
            "Provide a running Forge instance or pass --allow-missing-forge.",
            file=sys.stderr,
        )
        return 1
    if os.environ.get("FORGE_BASE_URL"):
        return run_command(
            "real Forge evidence", frontend_command("run", "test:e2e:forge"), ROOT, env, "release environment or real integration"
        )
    print("WARNING [release evidence]: real Forge evidence was explicitly omitted")
    return 0


def behavior_change(requirement_id: str, bump: bool) -> int:
    payload = load_json(REGISTRY_PATH)
    requirements = payload.get("requirements", [])
    requirement = next((item for item in requirements if item.get("id") == requirement_id), None)
    if requirement is None:
        print(f"Unknown requirement: {requirement_id}", file=sys.stderr)
        return 1
    print(f"{requirement_id}@{requirement['revision']}: {requirement['title']}")
    for line in requirement["acceptance"]:
        print(f"- {line}")
    if not bump:
        print(f"If behavior is intentionally changing, rerun with: python tools/test_gate.py behavior-change {requirement_id} --bump")
        return 0
    requirement["revision"] += 1
    REGISTRY_PATH.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    update_acceptance_doc(requirements)
    print(
        f"Bumped {requirement_id} to revision {requirement['revision']}. "
        "Affected acceptance tests are now intentionally stale until reviewed."
    )
    return 0


def main() -> int:
    args = parse_args()
    if args.command == "behavior-change":
        return behavior_change(args.requirement_id, args.bump)
    mode = args.mode if args.command == "preflight" else "affected" if args.command == "affected" else "full"
    result = validate_preflight(mode)
    status = print_preflight(result, mode)
    if status or args.command == "preflight":
        return status
    if args.command == "affected":
        return run_affected(result)
    if args.command == "full":
        return run_full()
    return run_full(release=True, allow_missing_forge=args.allow_missing_forge)


if __name__ == "__main__":
    raise SystemExit(main())
