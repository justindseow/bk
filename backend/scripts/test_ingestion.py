from __future__ import annotations

import argparse
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


def summarize_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "fileName": item.get("fileName"),
        "detectedType": item.get("detectedType"),
        "target": item.get("target"),
        "date": item.get("date"),
        "reference": item.get("reference"),
        "party": item.get("party"),
        "amount": item.get("amount"),
        "moneyIn": item.get("moneyIn"),
        "moneyOut": item.get("moneyOut"),
        "suggestedGlAccount": item.get("suggestedGlAccount"),
        "status": item.get("status"),
        "confidence": item.get("confidence"),
        "extractionMethod": item.get("extractionMethod"),
        "warnings": item.get("warnings"),
        "evidence": item.get("evidence"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the backend ingestion extractor directly against local docs.")
    parser.add_argument("paths", nargs="+", help="File paths to test")
    parser.add_argument("--lane", default="auto", choices=["auto", "purchases", "sales", "bank", "payments"])
    parser.add_argument("--client", default="THE SUBURBAN FOOD SDN BHD")
    parser.add_argument("--full", action="store_true", help="Print full JSON items instead of summarized output")
    args = parser.parse_args()

    all_results: list[dict[str, Any]] = []

    for raw_path in args.paths:
        path = Path(raw_path)
        if not path.exists() or not path.is_file():
            print(json.dumps({"path": raw_path, "error": "file_not_found"}, indent=2))
            continue

        data = path.read_bytes()
        items = extract_intake_items(
            path.name,
            infer_content_type(path),
            data,
            upload_lane=args.lane,
            client_entity_name=args.client,
        )
        all_results.append(
            {
                "path": str(path),
                "items": items if args.full else [summarize_item(item) for item in items],
            }
        )

    print(json.dumps(all_results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
