from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools import test_gate


class TestGateTests(unittest.TestCase):
    def test_registry_and_current_mappings_pass_full_preflight(self):
        result = test_gate.validate_preflight("full")
        self.assertEqual([], result.errors)
        self.assertGreaterEqual(len(result.requirements), 10)

    def test_semantic_pixel_lint_rejects_exact_e2e_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "layout.spec.ts"
            path.write_text("expect(box.x).toBe(0);", encoding="utf-8")
            self.assertIsNotNone(test_gate.EXACT_E2E_PIXEL_RE.search(path.read_text(encoding="utf-8")))

    def test_requirement_paths_match_affected_files(self):
        result = test_gate.validate_preflight("affected")
        impacted = test_gate.impacted_requirements(result, ["frontend/src/components/Surface.svelte"])
        self.assertIn("UI-WINDOW-001", impacted)

    def test_stale_acceptance_warns_in_affected_and_fails_in_full(self):
        requirements = {"UI-WINDOW-001": {"revision": 2}}
        mapping = test_gate.Mapping("frontend/tests/surface.test.ts", "UI-WINDOW-001@1", frozenset({"focus"}))

        self.assertEqual("warning", test_gate.mapping_issue(mapping, requirements, "affected")[0])
        self.assertEqual("error", test_gate.mapping_issue(mapping, requirements, "full")[0])

    def test_windows_command_resolution_accepts_script_shims(self):
        self.assertTrue(test_gate.executable("npx"))


if __name__ == "__main__":
    unittest.main()
