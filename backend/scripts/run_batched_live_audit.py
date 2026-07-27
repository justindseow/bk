from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
import sys
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.audit_test_docs import audit_folder


def merge_counter(into: Counter, values: dict[str, Any]) -> None:
    for key, value in values.items():
        into[key] += int(value or 0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the live extractor over a folder in resumable batches.")
    parser.add_argument(
        "--folder",
        default=str(REPO_ROOT / "test docs"),
        help="Folder containing source documents.",
    )
    parser.add_argument("--client", default="XYZ Co Sdn Bhd", help="Client entity name for extraction context.")
    parser.add_argument("--lane", default="auto", choices=["auto", "purchases", "sales", "bank", "payments"])
    parser.add_argument("--batch-size", type=int, default=20, help="Number of files per batch.")
    parser.add_argument("--start-offset", type=int, default=0, help="Zero-based file offset to begin from.")
    parser.add_argument("--max-batches", type=int, default=0, help="Maximum number of batches to run. 0 means all remaining batches.")
    parser.add_argument(
        "--output-dir",
        default=str(REPO_ROOT / "tmp-live-audit"),
        help="Directory where batch and aggregate JSON reports will be written.",
    )
    parser.add_argument("--limit", type=int, default=50, help="Maximum review files to keep in the aggregate report.")
    args = parser.parse_args()

    folder = Path(args.folder)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    all_files = [path for path in sorted(folder.glob("*")) if path.is_file()]
    total_files = len(all_files)
    batch_size = max(1, args.batch_size)
    start_offset = max(0, args.start_offset)

    aggregate_summary = Counter()
    aggregate_by_method = Counter()
    aggregate_by_type = Counter()
    aggregate_by_target = Counter()
    aggregate_review_files: list[dict[str, Any]] = []
    aggregate_accepted_files: list[dict[str, Any]] = []
    aggregate_wp2_multi_files: list[dict[str, Any]] = []

    batches_run = 0
    offset = start_offset
    while offset < total_files:
        if args.max_batches and batches_run >= args.max_batches:
            break

        report = audit_folder(
            folder,
            client_entity_name=args.client,
            upload_lane=args.lane,
            offset=offset,
            max_files=batch_size,
        )
        selection = report.get("selection", {})
        processed_files = int(selection.get("processed_files", 0))
        if processed_files <= 0:
            break

        batch_index = (offset // batch_size) + 1
        batch_output = output_dir / f"batch-{batch_index:03d}-offset-{offset:03d}.json"
        batch_output.write_text(json.dumps(report, indent=2), encoding="utf-8")

        merge_counter(aggregate_summary, report.get("summary", {}))
        merge_counter(aggregate_by_method, report.get("by_method", {}))
        merge_counter(aggregate_by_type, report.get("by_type", {}))
        merge_counter(aggregate_by_target, report.get("by_target", {}))
        aggregate_review_files.extend(report.get("review_files", []))
        aggregate_accepted_files.extend(report.get("accepted_files", []))
        aggregate_wp2_multi_files.extend(report.get("wp2_multi_files", []))

        offset += processed_files
        batches_run += 1

    aggregate_report = {
        "meta": {
            "folder": str(folder),
            "total_files_in_folder": total_files,
            "batch_size": batch_size,
            "start_offset": start_offset,
            "batches_run": batches_run,
            "files_processed": int(aggregate_summary.get("files", 0)),
            "completed_full_run": start_offset + int(aggregate_summary.get("files", 0)) >= total_files,
        },
        "summary": dict(aggregate_summary),
        "by_method": dict(aggregate_by_method),
        "by_type": dict(aggregate_by_type),
        "by_target": dict(aggregate_by_target),
        "wp2_multi_files": aggregate_wp2_multi_files[:100],
        "review_files": aggregate_review_files[: args.limit],
        "accepted_files": aggregate_accepted_files[: min(args.limit, 25)],
    }

    aggregate_path = output_dir / "aggregate.json"
    aggregate_path.write_text(json.dumps(aggregate_report, indent=2), encoding="utf-8")
    print(json.dumps(aggregate_report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
