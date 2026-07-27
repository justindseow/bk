from __future__ import annotations

import re
from typing import Any

from .memory import apply_memory_overrides, canonicalize_account_label, suggested_account_for_doc_type
from .normalization import (
    clamp_confidence,
    clean_reference,
    clean_words,
    confidence_label,
    current_timestamp,
    extract_reference,
    intake_id,
    normalize_date,
    normalize_doc_type,
    normalize_target,
    normalize_whitespace,
)

DEMO_PLACEHOLDER_PARTIES = {"xyz co sdn bhd"}
GENERIC_COMPANY_SUFFIX_TOKENS = {
    "enterprise",
    "trading",
    "services",
    "supplies",
    "supply",
    "resources",
    "restaurant",
    "cafe",
    "kitchen",
    "marketing",
    "industries",
}
GENERIC_PARTY_STOPWORDS = {
    "invoice",
    "inv",
    "bill",
    "receipt",
    "statement",
    "no",
    "nt",
    "ms",
    "m",
    "customer",
    "deliver",
    "delivery",
    "to",
    "billto",
}
LEADING_COMPANY_NOISE_TOKENS = {
    "payment",
    "paymen",
    "accepted",
    "though",
    "hough",
    "all",
    "cheque",
    "cheques",
    "crossed",
    "made",
    "payable",
    "please",
    "thank",
    "thanks",
    "with",
    "shopping",
}
PARTY_SDN_BHD_CAPTURE = re.compile(
    r"([A-Z0-9&'().,/ -]{4,}?SDN\.?\s*BHD\.?(?:\s*\([^)]{1,40}\))?)",
    re.I,
)
PARTY_GENERIC_COMPANY_CAPTURE = re.compile(
    r"([A-Z0-9&'().,/ -]{4,}?(?:ENTERPRISE|TRADING|SERVICES|SUPPLIES|SUPPLY|RESOURCES|RESTAURANT|CAFE|KITCHEN|MARKETING|INDUSTRIES)(?:\s*\([^)]{1,40}\))?)",
    re.I,
)
PARTY_NOISE_PATTERN = re.compile(r"[«»“”‘’`´|]")
PARTY_CONTACT_PATTERN = re.compile(r"\b(?:phone|tel|fax|email|e-mail|company no|tin no|sst no|reg no|reg\. no)\b", re.I)
LEADING_PARTY_JUNK_PATTERN = re.compile(
    r"^(?:(?:no|invoice|inv|bill|statement|delivery|note|nt|ms|m|customer|supplier|vendor|issued|from|to|for|by)\w*|[A-Z]{0,3}\d+[A-Z0-9/-]*|[^A-Za-z]+)+",
    re.I,
)
TRAILING_PARTY_JUNK_PATTERN = re.compile(
    r"(?:\b(?:phone|tel|fax|email|e-mail|company no|tin no|sst no|reg no|reg\. no)\b.*)$",
    re.I,
)
OCR_COMPANY_FIXUPS = (
    (re.compile(r"\bA\s*DN\s+BHD\b", re.I), "SDN BHD"),
    (re.compile(r"\bADN\s+BHD\b", re.I), "SDN BHD"),
    (re.compile(r"\bSD\s+BHD\b", re.I), "SDN BHD"),
    (re.compile(r"\bSD\s+BH\b", re.I), "SDN BHD"),
    (re.compile(r"\bS\s*DN\b", re.I), "SDN"),
    (re.compile(r"\bB\s*HD\b", re.I), "BHD"),
    (re.compile(r"\bT\s*RADING\b", re.I), "TRADING"),
    (re.compile(r"\bS\s*UPPLY\b", re.I), "SUPPLY"),
    (re.compile(r"\bS\s*ERVICES\b", re.I), "SERVICES"),
)


def _apply_company_ocr_fixups(value: str) -> str:
    fixed = value
    for pattern, replacement in OCR_COMPANY_FIXUPS:
        fixed = pattern.sub(replacement, fixed)
    return normalize_whitespace(fixed)


def _trim_leading_party_junk(value: str) -> str:
    cleaned = normalize_whitespace(value)
    if not cleaned:
        return ""

    previous = None
    while cleaned and cleaned != previous:
        previous = cleaned
        cleaned = normalize_whitespace(LEADING_PARTY_JUNK_PATTERN.sub("", cleaned)).strip(" -,:;/")

    tokens = cleaned.split()
    while len(tokens) >= 4:
        first = tokens[0].strip(".,()")
        second = tokens[1].strip(".,()")
        if (
            0 < len(first) <= 3
            and first.isalpha()
            and first.upper() == first
            and 0 < len(second) <= 3
            and second.isalpha()
            and second.upper() == second
            and any(token.strip(".,()").casefold() in GENERIC_COMPANY_SUFFIX_TOKENS for token in tokens[2:])
        ):
            tokens = tokens[1:]
            continue
        if (
            len(first) == 1
            and first.isalpha()
            and any(token.strip(".,()").casefold() in GENERIC_COMPANY_SUFFIX_TOKENS for token in tokens[1:])
        ):
            tokens = tokens[1:]
            continue
        break

    return normalize_whitespace(" ".join(tokens))


def _company_suffix_index(tokens: list[str]) -> int:
    normalized_tokens = [token.strip(".,()").casefold() for token in tokens]
    for index in range(len(normalized_tokens) - 1):
        if normalized_tokens[index] == "sdn" and normalized_tokens[index + 1] == "bhd":
            return index + 1
    for index in range(len(normalized_tokens) - 1, -1, -1):
        if normalized_tokens[index] in GENERIC_COMPANY_SUFFIX_TOKENS:
            return index
    return -1


def _sanitize_company_candidate(value: str) -> str:
    cleaned = _apply_company_ocr_fixups(normalize_whitespace(value))
    if not cleaned:
        return ""

    cleaned = normalize_whitespace(TRAILING_PARTY_JUNK_PATTERN.sub("", cleaned))
    cleaned = _trim_leading_party_junk(cleaned)
    if not cleaned:
        return ""

    tokens = cleaned.split()
    suffix_index = _company_suffix_index(tokens)
    if suffix_index >= 0:
        pre_suffix_tokens = [token for token in tokens[:suffix_index] if token.strip(".,()")]
        suffix_tokens = tokens[suffix_index:]
        had_prefix_noise = False

        while pre_suffix_tokens:
            normalized_first = pre_suffix_tokens[0].strip(".,()").casefold()
            if normalized_first in LEADING_COMPANY_NOISE_TOKENS:
                pre_suffix_tokens = pre_suffix_tokens[1:]
                had_prefix_noise = True
                continue
            if len(pre_suffix_tokens) > 1 and len(pre_suffix_tokens[0].strip(".,()")) <= 2:
                pre_suffix_tokens = pre_suffix_tokens[1:]
                had_prefix_noise = True
                continue
            break

        if had_prefix_noise and len(pre_suffix_tokens) > 3:
            pre_suffix_tokens = pre_suffix_tokens[-3:]
        if had_prefix_noise and (
            len(pre_suffix_tokens) >= 3
            and len(pre_suffix_tokens[0].strip(".,()")) <= 4
            and len(pre_suffix_tokens[1].strip(".,()")) >= 5
            and len(pre_suffix_tokens[2].strip(".,()")) >= 5
        ):
            pre_suffix_tokens = pre_suffix_tokens[1:]
        if (
            len(pre_suffix_tokens) >= 3
            and len(pre_suffix_tokens[0].strip(".,()")) <= 4
            and pre_suffix_tokens[0].strip(".,()").lower() == pre_suffix_tokens[0].strip(".,()")
            and len(pre_suffix_tokens[1].strip(".,()")) >= 5
            and len(pre_suffix_tokens[2].strip(".,()")) >= 5
        ):
            pre_suffix_tokens = pre_suffix_tokens[1:]
        if had_prefix_noise and len(pre_suffix_tokens) >= 2 and len(pre_suffix_tokens[0].strip(".,()")) <= 2:
            pre_suffix_tokens = pre_suffix_tokens[1:]

        cleaned = normalize_whitespace(" ".join([*pre_suffix_tokens, *suffix_tokens]))

    cleaned = re.sub(r"^[^A-Za-z0-9]+", "", cleaned)
    cleaned = re.sub(r"[^A-Za-z0-9)\]]+$", "", cleaned)
    cleaned = re.sub(r"\s*\(\s*[\d\s/-]{4,}[A-Z-]*\s*\)$", "", cleaned, flags=re.I)
    return normalize_whitespace(cleaned.strip(" -,:;/"))


def _normalized_party_key(value: str) -> str:
    return normalize_whitespace(value).casefold()


def _filename_party_fallback(file_name: str) -> str:
    return clean_words(str(file_name).rsplit(".", 1)[0])


def clean_party_value(party: str) -> str:
    cleaned = normalize_whitespace(party)
    if not cleaned:
        return ""

    cleaned = cleaned.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    cleaned = _apply_company_ocr_fixups(cleaned)
    cleaned = re.sub(r"^[^A-Za-z0-9]+", "", cleaned)
    cleaned = re.sub(r"[^A-Za-z0-9)\]]+$", "", cleaned)
    cleaned = normalize_whitespace(cleaned.strip(" -,:;/"))

    company_match = PARTY_SDN_BHD_CAPTURE.search(cleaned) or PARTY_GENERIC_COMPANY_CAPTURE.search(cleaned)
    if company_match:
        cleaned = _sanitize_company_candidate(company_match.group(0))
    else:
        tokens = cleaned.split()
        suffix_index = next(
            (
                index
                for index in range(len(tokens) - 1, -1, -1)
                if tokens[index].strip(".,()").casefold() in GENERIC_COMPANY_SUFFIX_TOKENS
            ),
            -1,
        )
        if suffix_index >= 0:
            selected: list[str] = []
            index = suffix_index
            while index >= 0 and len(selected) < 6:
                token = tokens[index].strip()
                normalized_token = token.strip(".,()").casefold()
                if selected and (any(character.isdigit() for character in token) or normalized_token in GENERIC_PARTY_STOPWORDS):
                    break
                if any(character.isalpha() for character in token):
                    selected.append(token)
                index -= 1
            if selected:
                cleaned = _sanitize_company_candidate(" ".join(reversed(selected)).strip(" -,:;/"))

    cleaned = _sanitize_company_candidate(cleaned)

    return cleaned[:120]


def looks_like_placeholder_party(
    party: str,
    *,
    file_name: str = "",
    client_entity_name: str | None = None,
    target: str = "WP1",
) -> bool:
    cleaned = clean_party_value(party)
    if not cleaned:
        return True

    normalized_party = _normalized_party_key(cleaned)
    if normalized_party in DEMO_PLACEHOLDER_PARTIES:
        return True

    fallback_party = _filename_party_fallback(file_name)
    if fallback_party and normalized_party == _normalized_party_key(fallback_party):
        return True

    client_entity = normalize_whitespace(client_entity_name or "")
    if target == "WP1" and client_entity and normalized_party == _normalized_party_key(client_entity):
        return True

    return False


def _party_quality_warnings(
    raw_party: str,
    cleaned_party: str,
    *,
    file_name: str,
    client_entity_name: str | None,
    target: str,
    raw_preview: str = "",
    detected_type: str = "",
) -> tuple[list[str], float | None]:
    warnings: list[str] = []
    confidence_cap: float | None = None

    normalized_party = _normalized_party_key(cleaned_party)
    fallback_party = _filename_party_fallback(file_name)
    normalized_fallback = _normalized_party_key(fallback_party)
    normalized_client = _normalized_party_key(client_entity_name or "")
    party_lowered = re.sub(r"[^a-z0-9]+", " ", cleaned_party.casefold()).strip()

    # Bank rows only need a workable bank description; OCR cleanup on that field
    # should not downgrade an otherwise valid WP2 extraction.
    if target != "WP1":
        return warnings, confidence_cap

    if not normalized_party or normalized_party == "review source document":
        warnings.append("Party could not be isolated confidently. Review before posting.")
        confidence_cap = 0.25
        return warnings, confidence_cap

    if normalized_party in DEMO_PLACEHOLDER_PARTIES:
        warnings.append("Party looks like a demo placeholder. Review before posting.")
        confidence_cap = 0.2

    if target == "WP1" and normalized_fallback and normalized_party == normalized_fallback:
        warnings.append("Party was filled from the uploaded filename. Review before posting.")
        confidence_cap = min(confidence_cap or 1.0, 0.35)

    if target == "WP1" and normalized_client and normalized_party == normalized_client:
        warnings.append("Party still matches the client entity. Review before posting.")
        confidence_cap = min(confidence_cap or 1.0, 0.3)

    if target == "WP1" and re.fullmatch(r"[a-z]{1,2}\s+sdn\s+bhd", party_lowered):
        warnings.append("Party looked too short to trust as a full company name. Review before posting.")
        confidence_cap = min(confidence_cap or 1.0, 0.35)

    if PARTY_CONTACT_PATTERN.search(raw_party):
        warnings.append("Party looked like contact details instead of a supplier/customer name. Review before posting.")
        confidence_cap = min(confidence_cap or 1.0, 0.25)

    preview_lowered = re.sub(r"[^a-z0-9]+", " ", normalize_whitespace(raw_preview).casefold()).strip()
    if target == "WP1" and "sdn bhd" in preview_lowered and "sdn bhd" not in party_lowered and detected_type not in {"Merchant Statement", "Merchant Discount Fee"}:
        warnings.append("Party did not capture the full company name visible in the source preview. Review before posting.")
        confidence_cap = min(confidence_cap or 1.0, 0.55)

    raw_normalized = normalize_whitespace(raw_party)
    if raw_normalized and cleaned_party and raw_normalized != cleaned_party:
        leading_junk = re.search(r"^[^A-Za-z0-9(]+", raw_party)
        trailing_junk = re.search(r"[^A-Za-z0-9.)]+$", raw_party)
        significant_change = abs(len(raw_normalized) - len(cleaned_party)) >= 3
        if PARTY_NOISE_PATTERN.search(raw_party) or leading_junk or (trailing_junk and significant_change):
            warnings.append("Party text was cleaned from noisy OCR characters. Review before posting.")
            confidence_cap = min(confidence_cap or 1.0, 0.68)

    return warnings, confidence_cap


def _required_fields_present(item: dict[str, Any]) -> bool:
    if item["target"] == "WP2":
        return bool(item["date"] and item["party"] and (item["moneyIn"] > 0 or item["moneyOut"] > 0 or item["amount"] > 0))
    return bool(
        item["date"]
        and item["party"]
        and item["amount"] > 0
        and item["detectedType"] != "Unknown"
        and item["suggestedGlAccount"]
    )


def _sales_summary_ready(item: dict[str, Any]) -> bool:
    if item["detectedType"] != "Sales Summary":
        return True

    party_confidence = clamp_confidence(item.get("fieldConfidence", {}).get("party", 0.0))
    amount_confidence = clamp_confidence(item.get("fieldConfidence", {}).get("amount", 0.0))
    warnings = [normalize_whitespace(line).lower() for line in item.get("warnings", [])]
    weak_label_warning = any("sales row label looked weak" in line or "fell back to the file channel" in line for line in warnings)

    return bool(
        party_confidence >= 0.75
        and amount_confidence >= 0.9
        and not weak_label_warning
    )


def _warnings_require_review(item: dict[str, Any]) -> bool:
    warnings = [normalize_whitespace(line).lower() for line in item.get("warnings", [])]
    review_signals = (
        "needs review",
        "date was not detected",
        "document_date is missing or unparseable",
        "year of the document date is unclear",
        "bank statement was inferred",
        "party still matches the client entity",
        "party was filled from the uploaded filename",
        "party looks like a demo placeholder",
        "party could not be isolated confidently",
        "party looked too short to trust as a full company name",
        "party text was cleaned from noisy ocr characters",
        "party looked like contact details instead of a supplier/customer name",
        "party did not capture the full company name visible in the source preview",
    )
    return any(signal in warning for warning in warnings for signal in review_signals)


def _status_for(item: dict[str, Any]) -> str:
    score = clamp_confidence(item.get("overallConfidenceScore", 0.0))
    return (
        "Accepted"
        if _required_fields_present(item)
        and _sales_summary_ready(item)
        and not _warnings_require_review(item)
        and score >= 0.78
        else "Needs Review"
    )


def build_item(
    *,
    file_name: str,
    file_type: str,
    file_size: int,
    uploaded_at: str | None = None,
    detected_type: str = "Unknown",
    target: str = "WP1",
    date: str = "",
    reference: str = "",
    party: str = "",
    amount: float = 0.0,
    money_in: float = 0.0,
    money_out: float = 0.0,
    suggested_gl_account: str = "",
    notes: str = "",
    evidence: list[str] | None = None,
    warnings: list[str] | None = None,
    raw_preview: str = "",
    overall_confidence_score: float = 0.0,
    extraction_method: str = "deterministic",
    field_confidence: dict[str, float] | None = None,
    field_evidence: dict[str, list[str]] | None = None,
    gl_suggestions: list[dict[str, Any]] | None = None,
    raw_source: dict[str, Any] | None = None,
    client_entity_name: str | None = None,
) -> dict[str, Any]:
    normalized_gl_account = canonicalize_account_label(suggested_gl_account)
    raw_party = normalize_whitespace(party)
    normalized_party = clean_party_value(raw_party)
    if not normalized_party:
        normalized_party = _filename_party_fallback(file_name)
    party_warnings, party_confidence_cap = _party_quality_warnings(
        raw_party,
        normalized_party,
        file_name=file_name,
        client_entity_name=client_entity_name,
        target=normalize_target(target, normalize_doc_type(detected_type)),
        raw_preview=raw_preview,
        detected_type=normalize_doc_type(detected_type),
    )
    item = {
        "id": intake_id(),
        "fileName": file_name,
        "fileType": file_type or "unknown",
        "fileSize": file_size,
        "uploadedAt": uploaded_at or current_timestamp(),
        "detectedType": normalize_doc_type(detected_type),
        "target": normalize_target(target, normalize_doc_type(detected_type)),
        "date": normalize_date(date),
        "reference": clean_reference(reference) if reference else extract_reference(raw_preview or file_name, file_name),
        "party": normalized_party,
        "amount": round(float(amount or 0), 2),
        "moneyIn": round(float(money_in or 0), 2),
        "moneyOut": round(float(money_out or 0), 2),
        "suggestedGlAccount": normalized_gl_account,
        "notes": normalize_whitespace(notes),
        "evidence": [normalize_whitespace(line) for line in (evidence or []) if normalize_whitespace(line)],
        "warnings": [
            *[normalize_whitespace(line) for line in (warnings or []) if normalize_whitespace(line)],
            *[normalize_whitespace(line) for line in party_warnings if normalize_whitespace(line)],
        ],
        "rawPreview": normalize_whitespace(raw_preview)[:240],
        "extractionMethod": extraction_method,
        "overallConfidenceScore": round(clamp_confidence(overall_confidence_score), 2),
        "fieldConfidence": {
            key: round(clamp_confidence(value), 2)
            for key, value in (field_confidence or {}).items()
        },
        "fieldEvidence": {
            key: [normalize_whitespace(line) for line in values if normalize_whitespace(line)]
            for key, values in (field_evidence or {}).items()
        },
        "glSuggestions": [
            {
                "account": normalize_whitespace(suggestion.get("account", "")),
                "confidence": round(clamp_confidence(suggestion.get("confidence", 0.0)), 2),
                "reason": normalize_whitespace(suggestion.get("reason", "")),
            }
            for suggestion in (gl_suggestions or [])
            if normalize_whitespace(suggestion.get("account", ""))
        ],
        "rawSource": {
            "fileName": normalize_whitespace(raw_source.get("file_name", "")),
            "headerRowNumber": raw_source.get("header_row_number"),
            "rowNumber": raw_source.get("row_number"),
            "headers": [normalize_whitespace(value) for value in raw_source.get("display_headers", raw_source.get("headers", [])) if normalize_whitespace(value)],
            "cells": [normalize_whitespace(value) for value in raw_source.get("cells", [])],
            "contextRows": [
                {
                    "rowNumber": context_row.get("row_number"),
                    "cells": [normalize_whitespace(value) for value in context_row.get("cells", [])],
                }
                for context_row in raw_source.get("context_rows", [])
                if context_row.get("row_number")
            ],
        } if raw_source else None,
    }

    if not item["suggestedGlAccount"]:
        item["suggestedGlAccount"] = suggested_account_for_doc_type(item["detectedType"])

    if party_confidence_cap is not None:
        current_party_confidence = item["fieldConfidence"].get("party", 1.0 if item["party"] else 0.0)
        item["fieldConfidence"]["party"] = round(min(current_party_confidence, party_confidence_cap), 2)
        item["overallConfidenceScore"] = round(min(float(item["overallConfidenceScore"] or 0.0), max(0.72, party_confidence_cap)), 2)

    item = apply_memory_overrides(item)
    item["confidence"] = confidence_label(item["overallConfidenceScore"])
    item["status"] = _status_for(item)
    return item
