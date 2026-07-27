from __future__ import annotations

from pathlib import Path
import sys

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.check_ingestion_regression import run_fixture


FIXTURES = [
    "ingestion_regression_expected.json",
    "ingestion_regression_expected_bk_review_reduction.json",
    "ingestion_regression_expected_critical.json",
    "ingestion_regression_expected_bk_release.json",
]


def main() -> int:
    failures_found = False

    for fixture_name in FIXTURES:
        fixture_path = Path(__file__).with_name(fixture_name)
        failures, fixture = run_fixture(fixture_path)
        case_count = len(fixture.get("cases", []))

        if failures:
            failures_found = True
            print(f"[FAIL] {fixture_name} ({case_count} cases)")
            for failure in failures:
                print(f"  - {failure}")
        else:
            print(f"[PASS] {fixture_name} ({case_count} cases)")

    if failures_found:
        print("BK RELEASE AUDIT FAILED")
        return 1

    print("BK RELEASE AUDIT PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
