from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.extractors import extract_intake_items


def infer_content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "application/pdf"
    if suffix in {".csv", ".txt", ".tsv", ".pat"}:
        return "text/plain"
    if suffix in {".xlsx", ".xlsm", ".xls"}:
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if suffix in {".png"}:
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    return "application/octet-stream"


def compare_value(actual: Any, expected: Any) -> bool:
    if isinstance(expected, float):
        try:
            return abs(float(actual) - expected) < 0.01
        except (TypeError, ValueError):
            return False
    return actual == expected


def compare_mapping(
    *,
    actual: dict[str, Any],
    expected: dict[str, Any],
    label: str,
    path: Path,
    failures: list[str],
) -> None:
    for field, expected_value in expected.items():
        actual_value = actual.get(field)
        if not compare_value(actual_value, expected_value):
            failures.append(
                f"{path}: {label} `{field}` expected `{expected_value}` but got `{actual_value}`"
            )


def run_fixture(fixture_path: Path) -> tuple[list[str], dict[str, Any]]:
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    client = fixture["client"]
    lane = fixture["lane"]
    cases = fixture["cases"]

    failures: list[str] = []

    for case in cases:
        path = Path(case["path"])
        expected = case.get("expected") or case.get("expected_first") or {}
        if not path.exists():
            failures.append(f"{path}: file not found")
            continue

        items = extract_intake_items(
            path.name,
            infer_content_type(path),
            path.read_bytes(),
            upload_lane=lane,
            client_entity_name=client,
        )
        if not items:
            failures.append(f"{path}: no items returned")
            continue

        expected_item_count = case.get("expected_item_count")
        if expected_item_count is not None and len(items) != int(expected_item_count):
            failures.append(
                f"{path}: item_count expected `{expected_item_count}` but got `{len(items)}`"
            )

        expected_status_counts = case.get("expected_status_counts", {})
        if expected_status_counts:
            actual_status_counts = dict(Counter(item.get("status") for item in items))
            compare_mapping(
                actual=actual_status_counts,
                expected=expected_status_counts,
                label="status_count",
                path=path,
                failures=failures,
            )

        expected_target_counts = case.get("expected_target_counts", {})
        if expected_target_counts:
            actual_target_counts = dict(Counter(item.get("target") for item in items))
            compare_mapping(
                actual=actual_target_counts,
                expected=expected_target_counts,
                label="target_count",
                path=path,
                failures=failures,
            )

        expected_type_counts = case.get("expected_type_counts", {})
        if expected_type_counts:
            actual_type_counts = dict(Counter(item.get("detectedType") for item in items))
            compare_mapping(
                actual=actual_type_counts,
                expected=expected_type_counts,
                label="type_count",
                path=path,
                failures=failures,
            )

        actual = items[0]
        compare_mapping(
            actual=actual,
            expected=expected,
            label="field",
            path=path,
            failures=failures,
        )

    return failures, fixture


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local ingestion regression checks against known docs.")
    parser.add_argument(
        "--fixture",
        default=str(Path(__file__).with_name("ingestion_regression_expected.json")),
        help="Path to the regression fixture JSON.",
    )
    args = parser.parse_args()

    fixture_path = Path(args.fixture)
    failures, fixture = run_fixture(fixture_path)
    cases = fixture["cases"]

    if failures:
        print("INGESTION REGRESSION FAILED")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("INGESTION REGRESSION PASSED")
    for case in cases:
        print(f"- {case['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
