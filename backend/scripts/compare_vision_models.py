from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
import sys
from typing import Iterator

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from scripts.audit_test_docs import audit_folder


@contextmanager
def temporary_env(overrides: dict[str, str | None]) -> Iterator[None]:
    original: dict[str, str | None] = {key: os.environ.get(key) for key in overrides}
    try:
        for key, value in overrides.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        yield
    finally:
        for key, value in original.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def build_summary(report: dict[str, object], vision_model: str) -> dict[str, object]:
    summary = Counter(report.get("summary", {}))
    return {
        "vision_model": vision_model,
        "files": int(summary.get("files", 0)),
        "items": int(summary.get("items", 0)),
        "accepted_items": int(summary.get("status_Accepted", 0)),
        "review_items": int(summary.get("status_Needs Review", 0)),
        "suspicious_party_items": int(summary.get("suspicious_party_items", 0)),
        "suspicious_party_accepted_items": int(summary.get("suspicious_party_accepted_items", 0)),
        "suspicious_party_files": int(summary.get("suspicious_party_files", 0)),
        "files_all_accepted": int(summary.get("files_all_accepted", 0)),
        "files_mixed": int(summary.get("files_mixed", 0)),
        "files_all_review": int(summary.get("files_all_review", 0)),
        "wp2_multi_files": len(report.get("wp2_multi_files", [])),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare multiple vision models against the same document folder.")
    parser.add_argument(
        "--folder",
        default=str(REPO_ROOT / "test docs"),
        help="Folder containing source documents.",
    )
    parser.add_argument("--client", default="XYZ Co Sdn Bhd", help="Client entity name to supply to the extractor.")
    parser.add_argument("--lane", default="auto", choices=["auto", "purchases", "sales", "bank", "payments"])
    parser.add_argument(
        "--models",
        nargs="+",
        default=[
            "google/gemini-2.5-flash",
            "anthropic/claude-sonnet-4",
            "openai/gpt-4.1",
        ],
        help="Vision models to compare in order.",
    )
    parser.add_argument(
        "--provider",
        default="openrouter",
        choices=["openrouter", "openai"],
        help="Provider to force during the comparison run.",
    )
    parser.add_argument(
        "--output-dir",
        default=str(REPO_ROOT / "tmp-model-compare"),
        help="Directory where JSON comparison reports will be written.",
    )
    args = parser.parse_args()

    folder = Path(args.folder)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    aggregate: list[dict[str, object]] = []

    for vision_model in args.models:
        env_overrides = {
            "AI_PROVIDER": args.provider,
            "OPENROUTER_VISION_MODEL": vision_model if args.provider == "openrouter" else os.getenv("OPENROUTER_VISION_MODEL"),
            "OPENAI_VISION_MODEL": vision_model if args.provider == "openai" else os.getenv("OPENAI_VISION_MODEL"),
        }
        with temporary_env(env_overrides):
            report = audit_folder(
                folder,
                client_entity_name=args.client,
                upload_lane=args.lane,
            )

        summary = build_summary(report, vision_model)
        aggregate.append(summary)

        model_slug = vision_model.replace("/", "__").replace(":", "__")
        (output_dir / f"{model_slug}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    ranked = sorted(
        aggregate,
        key=lambda item: (
            int(item["suspicious_party_accepted_items"]),
            int(item["suspicious_party_items"]),
            int(item["review_items"]),
        ),
    )

    comparison = {
        "meta": {
            "folder": str(folder),
            "client": args.client,
            "lane": args.lane,
            "provider": args.provider,
            "models_tested": args.models,
        },
        "ranked_models": ranked,
    }
    (output_dir / "comparison-summary.json").write_text(json.dumps(comparison, indent=2), encoding="utf-8")
    print(json.dumps(comparison, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
