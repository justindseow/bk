from __future__ import annotations

import base64
import csv
import re
import string
import time
from typing import Any

from .schemas import DocumentType, TargetType

AMOUNT_REGEX = r"(?:RM\s*)?\(?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d{2})?\)?"
MONTH_LOOKUP = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

DOCUMENT_TYPES: set[DocumentType] = {
    "Sales Invoice",
    "Sales Summary",
    "Purchase Invoice",
    "Payment Voucher",
    "Receipt",
    "Payroll Summary",
    "Loan / HP Statement",
    "Merchant Statement",
    "Merchant Discount Fee",
    "Utility Bill",
    "Bank Statement",
    "Unknown",
}


def intake_id() -> str:
    return f"INT-{time.time_ns()}"


def current_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def clamp_confidence(value: Any) -> float:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, score))


def confidence_label(score: float) -> str:
    if score >= 0.85:
        return "High"
    if score >= 0.65:
        return "Medium"
    return "Low"


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value).lower()).strip()


def normalize_whitespace(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_words(value: str) -> str:
    cleaned = re.sub(r"\.[^.]+$", "", value)
    cleaned = re.sub(r"[_-]+", " ", cleaned)
    return normalize_whitespace(cleaned)


def cell_to_text(value: Any) -> str:
    if value is None:
        return ""
    return normalize_whitespace(value)


def decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore")


def parse_amount(value: str | None) -> float:
    if not value:
        return 0.0
    text = str(value).strip()
    spaced_decimal = re.search(r"(\d[\d,]*)\s+(\d{2})$", text)
    if spaced_decimal and "." not in text:
        text = f"{spaced_decimal.group(1)}.{spaced_decimal.group(2)}"
    normalized = re.sub(r"[RMrm\s]", "", text)
    normalized = normalized.replace(",", "")
    if normalized.startswith("(") and normalized.endswith(")"):
        normalized = normalized[1:-1]
    try:
        return abs(float(normalized))
    except ValueError:
        return 0.0


def parse_signed_amount(value: str | None) -> tuple[float, str]:
    if not value:
        return 0.0, "IN"
    text = str(value).strip()
    amount = parse_amount(text)
    direction = "OUT" if text.startswith("-") or ("(" in text and ")" in text) else "IN"
    return amount, direction


def month_name(month: int) -> str:
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return months[month - 1] if 1 <= month <= 12 else ""


def _format_day_month(day: str, month: int) -> str:
    return f"{int(day):02d} {month_name(month)}"


def normalize_date(value: str) -> str:
    source = normalize_whitespace(value)
    if not source:
        return ""

    iso = re.search(r"\b(19\d{2}|20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b", source)
    if iso:
        return _format_day_month(iso.group(3), int(iso.group(2)))

    day_month = re.search(
        r"\b(0?[1-9]|[12]\d|3[01])\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b",
        source,
        re.I,
    )
    if day_month:
        return _format_day_month(day_month.group(1), MONTH_LOOKUP[day_month.group(2).lower()])

    day_month_sep = re.search(
        r"\b(0?[1-9]|[12]\d|3[01])[-/. ](jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:[-/. ](?:20\d{2}|\d{2}))?\b",
        source,
        re.I,
    )
    if day_month_sep:
        return _format_day_month(day_month_sep.group(1), MONTH_LOOKUP[day_month_sep.group(2).lower()])

    month_day = re.search(
        r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?:,?\s+\d{2,4})?\b",
        source,
        re.I,
    )
    if month_day:
        return _format_day_month(month_day.group(2), MONTH_LOOKUP[month_day.group(1).lower()])

    slash = re.search(r"\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](19\d{2}|20\d{2}|\d{2})\b", source)
    if slash:
        return _format_day_month(slash.group(1), int(slash.group(2)))

    slash_no_year = re.search(r"\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])\b", source)
    if slash_no_year:
        return _format_day_month(slash_no_year.group(1), int(slash_no_year.group(2)))

    return source if re.match(r"^\d{2}\s[A-Z][a-z]{2}$", source) else ""


def clean_reference(value: str) -> str:
    reference = normalize_whitespace(value).upper()
    return re.sub(r"\s+", "-", reference)


def extract_reference(source: str, fallback: str) -> str:
    labeled_patterns = (
        r"(?:invoice|tax invoice|receipt|official receipt|bill|statement|document|ref(?:erence)?|account)[ \t]*(?:no|number|#)?[ \t]*[:=-]?[ \t]*([A-Z0-9][A-Z0-9/-]{2,})",
        r"\b(?:inv|pv|or|rec|bill|pay|loan|chq|cn|dn)\b[ \t]*[:=-]?[ \t]*([A-Z0-9][A-Z0-9/-]{2,})",
    )
    for pattern in labeled_patterns:
        labeled = re.search(pattern, source, re.I)
        if labeled:
            return clean_reference(labeled.group(1))

    reference = re.search(r"\b(?:INV|PV|OR|REC|BILL|PAY|LOAN|CHQ|CN|DN)[-\s]?[A-Z0-9-]{2,}\b", source, re.I)
    if reference:
        return clean_reference(reference.group(0))

    long_numeric = re.search(r"\b([0-9]{6,})\b", source)
    if long_numeric:
        return clean_reference(long_numeric.group(1))

    cleaned = clean_words(fallback).upper()
    return "-".join(cleaned.split()[:3])


def extract_largest_amount(source: str) -> float:
    matches = re.findall(AMOUNT_REGEX, source, re.I)
    if not matches:
        return 0.0

    decimal_like = [match for match in matches if "." in match or "RM" in match.upper()]
    if decimal_like:
        return max([parse_amount(match) for match in decimal_like], default=0.0)

    return 0.0


def extract_document_amount(source: str) -> float:
    text = normalize_whitespace(source)
    if not text:
        return 0.0

    keyword_patterns = (
        "total due",
        "amount due",
        "net amount",
        "net total",
        "invoice total",
        "total payable",
        "balance due",
        "amount payable",
        "payment amount",
        "total sales",
        "net sales",
        "gross sales",
    )
    for keyword in keyword_patterns:
        pattern = rf"{re.escape(keyword)}[^0-9RM]{{0,20}}({AMOUNT_REGEX})"
        match = re.search(pattern, text, re.I)
        if match:
            amount = parse_amount(match.group(1))
            if amount > 0:
                return amount

    return extract_largest_amount(text)


def looks_like_readable_text(data: bytes) -> bool:
    if not data:
        return False

    sample = data[:4096]
    if b"\x00" in sample:
        return False

    try:
        decoded = decode_text(sample)
    except Exception:
        return False

    cleaned = decoded.strip()
    if not cleaned:
        return False

    printable = sum(1 for character in cleaned if character in string.printable or ord(character) >= 160)
    ratio = printable / max(len(cleaned), 1)
    return ratio >= 0.85


def normalize_doc_type(value: Any) -> DocumentType:
    text = normalize_whitespace(value)
    return text if text in DOCUMENT_TYPES else "Unknown"


def normalize_target(value: Any, fallback_doc_type: DocumentType = "Unknown") -> TargetType:
    text = normalize_whitespace(value)
    if text in {"WP1", "WP2", "Ignore"}:
        return text
    if fallback_doc_type == "Bank Statement":
        return "WP2"
    if fallback_doc_type == "Unknown":
        return "WP1"
    return "WP1"


def find_header_index(rows: list[list[str]]) -> int | None:
    for index, row in enumerate(rows[:20]):
        header_text = " ".join(normalize(cell) for cell in row)
        if re.search(r"date|transaction date", header_text) and re.search(
            r"amount|money in|debit|credit|total|gross sales|net sales|qty|quantity|category|receipt|transaction",
            header_text,
        ):
            return index
    return None


def split_delimited_rows(text: str) -> list[list[str]]:
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) < 2:
        return []
    dialect = csv.excel_tab if "\t" in lines[0] else csv.excel
    return [[cell.strip() for cell in row] for row in csv.reader(lines, dialect=dialect)]


def cell_at(headers: list[str], cells: list[str], candidates: list[str]) -> str:
    for index, header in enumerate(headers):
        if any(candidate in header for candidate in candidates):
            return cells[index].strip() if index < len(cells) else ""
    return ""


def cell_prefer(headers: list[str], cells: list[str], candidates: list[str]) -> str:
    for candidate in candidates:
        for index, header in enumerate(headers):
            if candidate in header:
                return cells[index].strip() if index < len(cells) else ""
    return ""


def file_data_url(content_type: str, data: bytes) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{content_type};base64,{encoded}"
