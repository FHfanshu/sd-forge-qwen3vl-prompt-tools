from __future__ import annotations

import argparse
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Loom unittest suite with skip-budget checks.")
    parser.add_argument("--start-dir", default="tests")
    parser.add_argument("--pattern", default="test*.py")
    parser.add_argument("--max-skips", type=int, default=None)
    parser.add_argument(
        "--require-kt",
        action="store_true",
        help="Require the real KohakuTerrarium contract module to be available and active.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    suite = unittest.defaultTestLoader.discover(args.start_dir, pattern=args.pattern)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    ok = result.wasSuccessful()
    skip_count = len(result.skipped)

    if args.max_skips is not None and skip_count > args.max_skips:
        print(f"ERROR: skip budget exceeded ({skip_count} > {args.max_skips})", file=sys.stderr)
        ok = False

    kt_modules = [
        module
        for name, module in sys.modules.items()
        if name.endswith("test_loom_kt_contract") and module is not None
    ]
    kt_available = any(bool(getattr(module, "KT_AVAILABLE", False)) for module in kt_modules)
    kt_skips = [reason for _test, reason in result.skipped if "KohakuTerrarium" in reason]
    if args.require_kt and (not kt_available or kt_skips):
        print(
            "ERROR: KohakuTerrarium contract tests were not active; "
            "install requirements-kt-test.txt and investigate collection.",
            file=sys.stderr,
        )
        ok = False

    print(f"Test summary: {result.testsRun} run, {skip_count} skipped")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
