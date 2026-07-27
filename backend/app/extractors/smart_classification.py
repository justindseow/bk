from __future__ import annotations

import os
from typing import Any

from .ai_provider import can_use_provider, classifier_model, completion_message_text, configured_provider, post_chat_completion
from .memory import account_label
from .normalization import normalize, normalize_whitespace
from .schemas import RevenueClassification

SMART_CLASSIFIER_PROMPT = """
You classify bookkeeping sales-source documents for a Malaysian bookkeeping workflow.

Your job:
1. Determine the most likely document type.
2. Suggest the best revenue GL account.
3. Rank up to 3 likely GL suggestions with confidence and short reasons.

Allowed document_type values:
- Sales Summary
- Sales Invoice
- Receipt
- Merchant Statement
- Unknown

Allowed GL suggestions for this classification:
- 4100 - Sales Revenue
- 4120 - F&B Revenue

Guidance:
- Use 4120 - F&B Revenue only when the file clearly relates to food, beverage, cafe, restaurant, kitchen, meals, menu items, dine-in, delivery food, or similar F&B activity.
- Use 4100 - Sales Revenue for general retail or generic sales when the file is not clearly F&B-specific.
- Merchant/platform payout files can still suggest 4120 when the underlying sales are obviously F&B-related.
- When unsure, prefer 4100 - Sales Revenue and lower the confidence rather than overfitting.
- Evidence should be short, concrete cues from the filename, headers, or row samples.
- warnings should mention ambiguity only when it is genuinely ambiguous.
""".strip()

_SALES_SIGNALS = (
    "sales",
    "gross",
    "net sales",
    "receipt",
    "merchant",
    "payout",
    "commission",
    "outlet",
    "category",
    "sku",
    "product",
    "kitchen",
    "beverage",
    "cafe",
    "restaurant",
    "food",
    "menu",
    "breakfast",
    "lunch",
    "dinner",
)


def smart_classifier_enabled() -> bool:
    enabled = os.getenv("OPENAI_SMART_CLASSIFIER_ENABLED", "true").strip().lower()
    return enabled not in {"0", "false", "no", "off"}


def can_use_smart_classifier() -> bool:
    if not smart_classifier_enabled():
        return False
    return can_use_provider()


def _structured_retry_count() -> int:
    try:
        return max(1, int(os.getenv("AI_STRUCTURED_RETRIES", "2")))
    except ValueError:
        return 2


def _extract_json_object(raw_content: str) -> str:
    text = (raw_content or "").strip()
    if not text:
        return text
    start = text.find("{")
    if start < 0:
        return text

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return text


def _parse_revenue_response(raw_content: str) -> RevenueClassification:
    try:
        return RevenueClassification.model_validate_json(raw_content)
    except Exception as exc:
        extracted_json = _extract_json_object(raw_content)
        if extracted_json != raw_content:
            try:
                return RevenueClassification.model_validate_json(extracted_json)
            except Exception:
                pass
        raise RuntimeError(f"Structured revenue-classifier response was invalid: {exc}") from exc


def looks_like_revenue_document(*parts: str) -> bool:
    content = normalize(" ".join(part for part in parts if part))
    return any(signal in content for signal in _SALES_SIGNALS)


def classify_revenue_context(
    *,
    filename: str,
    headers: list[str] | None = None,
    sample_rows: list[str] | None = None,
    raw_text: str = "",
    row_count: int = 0,
) -> dict[str, Any] | None:
    header_text = " | ".join(headers or [])
    row_samples = [normalize_whitespace(row) for row in (sample_rows or []) if normalize_whitespace(row)]
    preview_text = normalize_whitespace(raw_text)[:2500]
    invoice_like_source = normalize(" ".join([filename, header_text, preview_text, *row_samples[:6]]))

    explicit_sales_side = any(
        token in invoice_like_source
        for token in ("sales invoice", "customer invoice", "invoice to", "sales summary", "merchant statement", "merchant payout")
    )
    generic_invoice_like = "invoice" in invoice_like_source
    purchase_side_invoice = any(
        token in invoice_like_source
        for token in ("tax invoice", "purchase invoice", "supplier invoice", "vendor invoice", "bill to", "deliver to", "amount due", "invoice date")
    )

    if (generic_invoice_like or purchase_side_invoice) and not explicit_sales_side:
        return None

    if not looks_like_revenue_document(filename, header_text, " ".join(row_samples), preview_text):
        return None

    heuristic = _heuristic_revenue_classification(filename, header_text, row_samples, row_count, preview_text)
    if not can_use_smart_classifier():
        return heuristic

    prompt = _build_prompt(
        filename=filename,
        headers=headers or [],
        sample_rows=row_samples,
        row_count=row_count,
        raw_text=preview_text,
    )

    try:
        result = _classify_with_provider(prompt)
    except Exception as exc:
        fallback = dict(heuristic)
        fallback["warnings"] = [*fallback.get("warnings", []), f"AI revenue classifier fallback used: {exc}"]
        fallback["evidence"] = [*fallback.get("evidence", []), "Fell back to deterministic revenue classification."]
        return fallback

    suggestions = [
        {
            "account": normalize_whitespace(suggestion.account),
            "confidence": round(float(suggestion.confidence or 0), 2),
            "reason": normalize_whitespace(suggestion.reason),
        }
        for suggestion in result.gl_suggestions
        if normalize_whitespace(suggestion.account)
    ]

    primary_account = normalize_whitespace(result.suggested_gl_account)
    if not primary_account and suggestions:
        primary_account = suggestions[0]["account"]

    if primary_account not in {account_label("4100"), account_label("4120")}:
        primary_account = heuristic["suggestedGlAccount"]

    evidence = [normalize_whitespace(line) for line in result.evidence if normalize_whitespace(line)]
    warnings = [normalize_whitespace(line) for line in result.warnings if normalize_whitespace(line)]

    if not evidence:
        evidence = heuristic["evidence"]

    return {
        "detectedType": result.document_type if result.document_type != "Unknown" else heuristic["detectedType"],
        "confidenceScore": max(round(float(result.overall_confidence or 0), 2), heuristic["confidenceScore"] - 0.05),
        "target": "WP1",
        "evidence": [
            *evidence,
            *( [normalize_whitespace(result.summary)] if normalize_whitespace(result.summary) else [] ),
            f"Revenue classifier model: {classifier_model()} via {configured_provider()}.",
        ],
        "warnings": warnings,
        "suggestedGlAccount": primary_account or heuristic["suggestedGlAccount"],
        "glSuggestions": suggestions or heuristic["glSuggestions"],
        "salesChannel": normalize_whitespace(result.sales_channel),
    }


def _build_prompt(
    *,
    filename: str,
    headers: list[str],
    sample_rows: list[str],
    row_count: int,
    raw_text: str,
) -> str:
    row_block = "\n".join(f"- {row}" for row in sample_rows[:12])
    header_block = ", ".join(headers[:30]) or "(none)"
    return f"""
Classify this uploaded bookkeeping file.

Filename:
{filename}

Headers:
{header_block}

Approximate row count:
{row_count}

Sample rows:
{row_block or "- (none)"}

Additional text:
{raw_text or "(none)"}
""".strip()


def _heuristic_revenue_classification(
    filename: str,
    header_text: str,
    sample_rows: list[str],
    row_count: int,
    raw_text: str,
) -> dict[str, Any]:
    content = normalize(" ".join([filename, header_text, raw_text, *sample_rows[:12]]))
    fnb_signals = (
        "kitchen",
        "breakfast",
        "lunch",
        "dinner",
        "beverage",
        "cafe",
        "restaurant",
        "food",
        "menu",
        "grabfood",
        "foodpanda",
    )
    merchant_signals = ("merchant", "payout", "settlement", "commission", "platform", "grab", "foodpanda")
    summary_signals = ("sales by category", "daily sales", "net sales", "gross sales", "category", "qty", "transaction")

    if any(signal in content for signal in merchant_signals):
        detected_type = "Merchant Statement"
    elif any(signal in content for signal in summary_signals) or row_count > 10:
        detected_type = "Sales Summary"
    elif "invoice" in content:
        detected_type = "Sales Invoice"
    elif "receipt" in content:
        detected_type = "Receipt"
    else:
        detected_type = "Sales Summary"

    fnb_hits = [signal for signal in fnb_signals if signal in content]
    primary_account = account_label("4120") if fnb_hits else account_label("4100")
    secondary_account = account_label("4100") if fnb_hits else account_label("4120")
    primary_confidence = 0.86 if fnb_hits else 0.74

    evidence = []
    if fnb_hits:
        evidence.append(f"Detected F&B-style cues: {', '.join(sorted(set(fnb_hits)))}.")
    if detected_type == "Sales Summary":
        evidence.append("Detected sales-summary style layout or repeated sales rows.")
    if detected_type == "Merchant Statement":
        evidence.append("Detected merchant payout or settlement clues.")
    if not evidence:
        evidence.append("Detected revenue-related sales cues in the uploaded file.")

    suggestions = [
        {
            "account": primary_account,
            "confidence": round(primary_confidence, 2),
            "reason": "F&B signals were stronger than generic sales signals." if fnb_hits else "Generic sales signals were present without clear F&B-specific cues.",
        },
        {
            "account": secondary_account,
            "confidence": 0.45 if fnb_hits else 0.52,
            "reason": "Fallback alternative revenue account.",
        },
    ]

    return {
        "detectedType": detected_type,
        "confidenceScore": primary_confidence,
        "target": "WP1",
        "evidence": evidence,
        "warnings": [],
        "suggestedGlAccount": primary_account,
        "glSuggestions": suggestions,
        "salesChannel": "F&B" if fnb_hits else "General Sales",
    }


def _classify_with_provider(prompt: str) -> RevenueClassification:
    if configured_provider() == "openrouter":
        return _classify_with_openrouter(prompt)
    return _classify_with_openai(prompt)


def _classify_with_openai(prompt: str) -> RevenueClassification:
    last_error: Exception | None = None
    for _ in range(_structured_retry_count()):
        response = post_chat_completion(
            model=classifier_model(),
            messages=[
                {"role": "system", "content": SMART_CLASSIFIER_PROMPT},
                {"role": "user", "content": prompt},
            ],
            schema_name="revenue_classification",
            schema=RevenueClassification.model_json_schema(),
        )
        raw_content = completion_message_text(response)
        try:
            return _parse_revenue_response(raw_content)
        except Exception as exc:
            last_error = exc
    assert last_error is not None
    raise last_error


def _classify_with_openrouter(prompt: str) -> RevenueClassification:
    last_error: Exception | None = None
    for _ in range(_structured_retry_count()):
        response = post_chat_completion(
            model=classifier_model(),
            messages=[
                {"role": "system", "content": SMART_CLASSIFIER_PROMPT},
                {"role": "user", "content": prompt},
            ],
            schema_name="revenue_classification",
            schema=RevenueClassification.model_json_schema(),
            extra_body={"provider": {"require_parameters": True}},
        )
        raw_content = completion_message_text(response)
        try:
            return _parse_revenue_response(raw_content)
        except Exception as exc:
            last_error = exc
    assert last_error is not None
    raise last_error
