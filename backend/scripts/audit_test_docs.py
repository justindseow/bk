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

from app.extractors import extract_intake_items


CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".tsv": "text/tab-separated-values",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xls": "application/vnd.ms-excel",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


def summarize_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "detectedType": item.get("detectedType"),
        "target": item.get("target"),
        "status": item.get("status"),
        "date": item.get("date"),
        "reference": item.get("reference"),
        "party": item.get("party"),
        "amount": item.get("amount"),
        "moneyIn": item.get("moneyIn"),
        "moneyOut": item.get("moneyOut"),
        "method": item.get("extractionMethod"),
        "warnings": item.get("warnings", [])[:4],
    }


def _normalized(value: str) -> str:
    return " ".join("".join(character.lower() if character.isalnum() else " " for character in value).split())


def suspicious_party_reason(item: dict[str, Any], client_entity_name: str) -> str | None:
    party = str(item.get("party", "") or "").strip()
    normalized_party = _normalized(party)
    normalized_client = _normalized(client_entity_name)

    if not normalized_party or normalized_party == "review source document":
        return "empty_or_review_placeholder"
    if normalized_party == "xyz co sdn bhd":
        return "demo_placeholder"
    if normalized_client and normalized_party == normalized_client and item.get("target") == "WP1":
        return "matches_client_name"
    return None


def audit_folder(
    folder: Path,
    client_entity_name: str,
    upload_lane: str,
    *,
    offset: int = 0,
    max_files: int = 0,
) -> dict[str, Any]:
    summary = Counter()
    by_method = Counter()
    by_type = Counter()
    by_target = Counter()
    review_files: list[dict[str, Any]] = []
    accepted_files: list[dict[str, Any]] = []
    wp2_multi_files: list[dict[str, Any]] = []
    selected_files = [path for path in sorted(folder.glob("*")) if path.is_file()]
    if offset > 0:
        selected_files = selected_files[offset:]
    if max_files > 0:
        selected_files = selected_files[:max_files]

    for path in selected_files:
        content_type = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        items = extract_intake_items(
            path.name,
            content_type,
            path.read_bytes(),
            upload_lane=upload_lane,
            client_entity_name=client_entity_name,
        )

        summary["files"] += 1
        summary["items"] += len(items)

        statuses = Counter(item.get("status") for item in items)
        if statuses.get("Needs Review") and not statuses.get("Accepted"):
            summary["files_all_review"] += 1
        if statuses.get("Accepted") and not statuses.get("Needs Review"):
            summary["files_all_accepted"] += 1
        if statuses.get("Accepted") and statuses.get("Needs Review"):
            summary["files_mixed"] += 1

        for item in items:
            summary[f"status_{item.get('status')}"] += 1
            by_method[item.get("extractionMethod")] += 1
            by_type[item.get("detectedType")] += 1
            by_target[item.get("target")] += 1
            reason = suspicious_party_reason(item, client_entity_name)
            if reason:
                summary["suspicious_party_items"] += 1
                summary[f"suspicious_party_{reason}"] += 1
                if item.get("status") == "Accepted":
                    summary["suspicious_party_accepted_items"] += 1
                    summary[f"suspicious_party_accepted_{reason}"] += 1

        record = {
            "file": path.name,
            "count": len(items),
            "items": [summarize_item(item) for item in items[:5]],
        }

        if any(item.get("target") == "WP2" for item in items) and len(items) > 1:
            wp2_multi_files.append({"file": path.name, "count": len(items)})

        if any(suspicious_party_reason(item, client_entity_name) for item in items):
            summary["suspicious_party_files"] += 1

        if any(item.get("status") == "Needs Review" for item in items):
            review_files.append(record)
        else:
            accepted_files.append(record)

    return {
        "summary": dict(summary),
        "by_method": dict(by_method),
        "by_type": dict(by_type),
        "by_target": dict(by_target),
        "selection": {
            "offset": offset,
            "max_files": max_files,
            "processed_files": len(selected_files),
        },
        "review_files": review_files,
        "accepted_files": accepted_files,
        "wp2_multi_files": wp2_multi_files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit local test-doc extraction results.")
    parser.add_argument(
        "--folder",
        default=str(REPO_ROOT / "test docs"),
        help="Folder containing test documents.",
    )
    parser.add_argument("--client", default="XYZ Co Sdn Bhd", help="Client entity name to supply to the extractor.")
    parser.add_argument("--lane", default="auto", choices=["auto", "purchases", "sales", "bank", "payments"])
    parser.add_argument("--limit", type=int, default=40, help="Maximum number of review/accepted file entries to print.")
    parser.add_argument("--only-review", action="store_true", help="Print only files that still need review.")
    parser.add_argument("--json-output", default="", help="Optional path to write the full JSON report.")
    parser.add_argument("--offset", type=int, default=0, help="Zero-based file offset for batched corpus runs.")
    parser.add_argument("--max-files", type=int, default=0, help="Maximum number of files to process in this batch. 0 means all files.")
    args = parser.parse_args()

    folder = Path(args.folder)
    report = audit_folder(
        folder,
        client_entity_name=args.client,
        upload_lane=args.lane,
        offset=args.offset,
        max_files=args.max_files,
    )

    if args.json_output:
        output_path = Path(args.json_output)
        output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    condensed = {
        "summary": report["summary"],
        "by_method": report["by_method"],
        "by_type": report["by_type"],
        "by_target": report["by_target"],
        "wp2_multi_files": report["wp2_multi_files"][:10],
        "review_files": report["review_files"][: args.limit],
    }
    if not args.only_review:
        condensed["accepted_files"] = report["accepted_files"][: min(args.limit, 20)]

    print(json.dumps(condensed, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
