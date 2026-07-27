from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .normalization import clean_words, normalize, normalize_doc_type, normalize_whitespace
from .schemas import DocumentType, TargetType

ACCOUNT_NAMES = {
    "4100": "Sales Revenue",
    "4120": "F&B Revenue",
    "5020": "Direct Materials",
    "6100": "Salaries & Wages",
    "6200": "Rent Expense",
    "6210": "Utilities Electricity",
    "6370": "Bank Charges & Fees",
    "6380": "Insurance Expense",
    "2700": "Term Loan Payable",
}
ACCOUNT_ALIASES = {
    "sales": "4100",
    "sales revenue": "4100",
    "revenue": "4100",
    "f b revenue": "4120",
    "f and b revenue": "4120",
    "food beverage revenue": "4120",
    "food and beverage revenue": "4120",
    "purchases": "5020",
    "direct materials": "5020",
    "cost of goods sold": "5020",
    "cogs": "5020",
    "salaries": "6100",
    "salaries wages": "6100",
    "wages": "6100",
    "rent": "6200",
    "rent expense": "6200",
    "utilities": "6210",
    "electricity": "6210",
    "bank charges": "6370",
    "bank fees": "6370",
    "insurance": "6380",
    "insurance expense": "6380",
    "premium": "6380",
    "loan": "2700",
    "hire purchase": "2700",
    "term loan payable": "2700",
}


def account_label(code: str) -> str:
    return f"{code} - {ACCOUNT_NAMES[code]}" if code and code in ACCOUNT_NAMES else ""


def canonicalize_account_label(value: str) -> str:
    text = normalize_whitespace(value)
    if not text:
        return ""

    direct_code_match = text.split("-", 1)[0].strip()
    if direct_code_match in ACCOUNT_NAMES:
        return account_label(direct_code_match)

    normalized_value = normalize(text)
    if normalized_value in ACCOUNT_ALIASES:
        return account_label(ACCOUNT_ALIASES[normalized_value])

    for alias, code in ACCOUNT_ALIASES.items():
        if alias in normalized_value:
            return account_label(code)

    for code, name in ACCOUNT_NAMES.items():
        if normalize(name) == normalized_value:
            return account_label(code)
    return ""


@dataclass(frozen=True)
class KnowledgeRule:
    label: str
    doc_type: DocumentType
    target: TargetType
    keywords: tuple[str, ...]
    account_code: str = ""


SMART_RULES = [
    KnowledgeRule("Bank statement layout", "Bank Statement", "WP2", ("bank statement", "account statement", "opening balance", "closing balance")),
    KnowledgeRule("Bank statement naming", "Bank Statement", "WP2", ("statement period", "statement date", "beginning balance", "ending balance", "statement of account", "current account")),
    KnowledgeRule("Bank transaction columns", "Bank Statement", "WP2", ("money in", "money out", "debit", "credit")),
    KnowledgeRule("Sales summary export", "Sales Summary", "WP1", ("sales by category", "sales by", "gross sales", "net sales", "daily sales", "sales report", "pos sales"), "4100"),
    KnowledgeRule("TNB utilities", "Utility Bill", "WP1", ("tnb", "tenaga", "electricity", "utility"), "6210"),
    KnowledgeRule("Water utility", "Utility Bill", "WP1", ("air selangor", "water bill", "utility"), "6210"),
    KnowledgeRule("Merchant payout", "Merchant Statement", "WP1", ("grab", "foodpanda", "merchant", "payout", "settlement"), "4120"),
    KnowledgeRule("Payroll support", "Payroll Summary", "WP1", ("payroll", "salary", "epf", "socso", "eis", "pcb"), "6100"),
    KnowledgeRule("Loan repayment support", "Loan / HP Statement", "WP1", ("loan", "hire purchase", "principal", "interest", "instalment"), "2700"),
    KnowledgeRule("Insurance / takaful", "Payment Voucher", "WP1", ("insurance", "takaful", "premium"), "6380"),
    KnowledgeRule("Rent payment", "Payment Voucher", "WP1", ("rental", "rent", "landlord"), "6200"),
    KnowledgeRule("Bank charges", "Bank Statement", "WP2", ("bank charge", "bank fee", "cash management fee", "monthly service fee"), "6370"),
    KnowledgeRule("Sales invoice", "Sales Invoice", "WP1", ("sales invoice", "customer invoice", "invoice to"), "4100"),
    KnowledgeRule("Supplier invoice", "Purchase Invoice", "WP1", ("supplier invoice", "purchase invoice", "vendor invoice", "bill from", "tax invoice", "invoice no", "invoice date", "amount due", "total due", "invoice total"), "5020"),
    KnowledgeRule("Receipt", "Receipt", "WP1", ("official receipt", "receipt", "cash bill"), "4100"),
    KnowledgeRule("Payment voucher", "Payment Voucher", "WP1", ("payment voucher", "pv"), "5020"),
]

BANK_FILENAME_TOKENS = ("statement", "bank", "cimb", "maybank", "rhb", "public bank", "hong leong", "uob", "ocbc", "ambank", "bsn", "current account", "savings account")
PURCHASE_FILENAME_TOKENS = ("supply", "supplies", "supplier", "invoice", "bill", "trading", "enterprise", "services", "resources", "marketing", "industries")
SALES_FILENAME_TOKENS = ("sales", "receipt", "merchant", "grab", "foodpanda", "customer")
PAYMENT_FILENAME_TOKENS = ("payment", "voucher", "pv", "expense", "utilities", "rental")
UPLOAD_LANES = {"auto", "purchases", "sales", "bank", "payments"}
BANK_SIGNAL_TOKENS = (
    "bank statement",
    "account statement",
    "statement of account",
    "opening balance",
    "closing balance",
    "current account",
    "savings account",
    "money in",
    "money out",
    "debit",
    "credit",
)


def normalize_upload_lane(upload_lane: str | None) -> str:
    normalized = (upload_lane or "auto").strip().lower()
    return normalized if normalized in UPLOAD_LANES else "auto"


def looks_bank_like(source: str) -> bool:
    normalized_source = normalize(source)
    return any(token in normalized_source for token in BANK_SIGNAL_TOKENS)


def apply_upload_lane_hint(
    detection: dict[str, Any],
    upload_lane: str | None,
    *,
    source: str = "",
) -> dict[str, Any]:
    lane = normalize_upload_lane(upload_lane)
    if lane == "auto":
        return detection

    hinted = dict(detection)
    evidence = list(hinted.get("evidence", []))
    warnings = list(hinted.get("warnings", []))
    normalized_source = normalize(source)
    doc_type = hinted.get("detectedType", "Unknown")

    if lane == "purchases":
        if doc_type in {"Unknown", "Sales Invoice"} and "invoice" in normalized_source:
            hinted["detectedType"] = "Purchase Invoice"
            hinted["target"] = "WP1"
            hinted["suggestedGlAccount"] = account_label("5020")
            hinted["confidenceScore"] = max(float(hinted.get("confidenceScore", 0.0)), 0.74)
            evidence.append("Upload lane was Purchases, so invoice-style content was biased toward Purchase Invoice.")
            if doc_type == "Sales Invoice":
                warnings.append("Purchase upload lane overrode a generic sales-invoice guess.")
        elif doc_type == "Unknown":
            hinted["detectedType"] = "Purchase Invoice"
            hinted["target"] = "WP1"
            hinted["suggestedGlAccount"] = account_label("5020")
            hinted["confidenceScore"] = max(float(hinted.get("confidenceScore", 0.0)), 0.52)
            evidence.append("Upload lane was Purchases, so the document was treated as purchase-side support.")
            warnings.append("Purchase upload lane supplied the main classification prior. Review before posting.")

    elif lane == "sales":
        has_explicit_sales_cue = any(
            token in normalized_source
            for token in ("sales invoice", "invoice to", "customer invoice", "issued by", "receipt", "sales summary")
        )
        has_supplier_cue = any(
            token in normalized_source
            for token in ("supplier invoice", "purchase invoice", "vendor invoice", "bill from", "tax invoice", "deliver to", "bill to", "amount due")
        )
        if doc_type == "Unknown" and has_explicit_sales_cue and not has_supplier_cue:
            hinted["detectedType"] = "Sales Invoice"
            hinted["target"] = "WP1"
            hinted["suggestedGlAccount"] = hinted.get("suggestedGlAccount") or account_label("4100")
            hinted["confidenceScore"] = max(float(hinted.get("confidenceScore", 0.0)), 0.62)
            evidence.append("Upload lane was Sales, but only explicit sales-side wording was allowed to bias the document toward Sales Invoice.")

    elif lane == "bank":
        if (doc_type == "Unknown" or doc_type != "Bank Statement") and looks_bank_like(source):
            hinted["detectedType"] = "Bank Statement"
            hinted["target"] = "WP2"
            hinted["suggestedGlAccount"] = ""
            hinted["confidenceScore"] = max(float(hinted.get("confidenceScore", 0.0)), 0.58)
            evidence.append("Upload lane was Bank, so the document was treated as bank-side support.")
            if doc_type != "Unknown":
                warnings.append("Bank upload lane overrode a non-bank classification guess.")

    elif lane == "payments":
        if doc_type in {"Unknown", "Sales Invoice"}:
            hinted["detectedType"] = "Payment Voucher"
            hinted["target"] = "WP1"
            hinted["suggestedGlAccount"] = account_label("5020")
            hinted["confidenceScore"] = max(float(hinted.get("confidenceScore", 0.0)), 0.58)
            evidence.append("Upload lane was Payments, so the document was treated as payment-side support.")
            if doc_type == "Sales Invoice":
                warnings.append("Payments upload lane overrode a generic sales-invoice guess.")

    hinted["evidence"] = evidence
    hinted["warnings"] = warnings
    return hinted


def detect_type(source: str, upload_lane: str | None = None) -> dict[str, Any]:
    content = normalize(source)
    ranked = []
    for rule in SMART_RULES:
        hits = [keyword for keyword in rule.keywords if keyword in content]
        if hits:
            ranked.append((len(hits), rule, hits))

    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked:
        heuristic = _heuristic_detection(content)
        if heuristic:
            return apply_upload_lane_hint(heuristic, upload_lane, source=source)
        return apply_upload_lane_hint({
            "detectedType": "Unknown",
            "confidenceScore": 0.35,
            "target": "WP1",
            "evidence": ["No reliable keyword pattern matched."],
            "warnings": ["Imported as a review item. Choose document type and GL downstream."],
            "suggestedGlAccount": "",
        }, upload_lane, source=source)

    score, rule, hits = ranked[0]
    confidence_score = 0.92 if score >= 2 else 0.72
    warnings = [] if score >= 2 else ["Only one strong clue found. Review before posting."]
    if len(ranked) > 1 and ranked[1][0] == score and ranked[1][1].doc_type != rule.doc_type:
        warnings.append(f"Also looked like {ranked[1][1].doc_type}.")

    return apply_upload_lane_hint({
        "detectedType": rule.doc_type,
        "confidenceScore": confidence_score,
        "target": rule.target,
        "evidence": [f"Matched {rule.label}: {', '.join(hits)}"],
        "warnings": warnings,
        "suggestedGlAccount": account_label(rule.account_code),
    }, upload_lane, source=source)


def _heuristic_detection(content: str) -> dict[str, Any] | None:
    if looks_bank_like(content) or ("statement" in content and any(token in content for token in BANK_FILENAME_TOKENS)):
        return {
            "detectedType": "Bank Statement",
            "confidenceScore": 0.58,
            "target": "WP2",
            "evidence": ["Used bank-statement filename or text clues."],
            "warnings": ["Bank statement was inferred from filename/text clues. Review before posting."],
            "suggestedGlAccount": "",
        }
    if "tax invoice" in content or ("invoice" in content and any(token in content for token in PURCHASE_FILENAME_TOKENS)) or any(token in content for token in ("supply", "supplier", "trading", "enterprise")):
        return {
            "detectedType": "Purchase Invoice",
            "confidenceScore": 0.62,
            "target": "WP1",
            "evidence": ["Used purchase-invoice filename or text clues."],
            "warnings": ["Invoice type was inferred from filename/text clues. Review before posting."],
            "suggestedGlAccount": account_label("5020"),
        }
    if any(token in content for token in SALES_FILENAME_TOKENS) and "invoice" in content:
        return {
            "detectedType": "Sales Invoice",
            "confidenceScore": 0.6,
            "target": "WP1",
            "evidence": ["Used sales-invoice filename or text clues."],
            "warnings": ["Sales invoice type was inferred from filename/text clues. Review before posting."],
            "suggestedGlAccount": account_label("4100"),
        }
    if any(token in content for token in PAYMENT_FILENAME_TOKENS):
        return {
            "detectedType": "Payment Voucher",
            "confidenceScore": 0.56,
            "target": "WP1",
            "evidence": ["Used payment-support filename or text clues."],
            "warnings": ["Payment support type was inferred from filename/text clues. Review before posting."],
            "suggestedGlAccount": account_label("5020"),
        }
    return None


def suggested_account_for_doc_type(doc_type: str) -> str:
    mapping = {
        "Sales Invoice": "4100",
        "Sales Summary": "4100",
        "Receipt": "4100",
        "Merchant Statement": "4120",
        "Purchase Invoice": "5020",
        "Payment Voucher": "5020",
        "Payroll Summary": "6100",
        "Loan / HP Statement": "2700",
        "Utility Bill": "6210",
    }
    return account_label(mapping.get(doc_type, ""))


def apply_memory_overrides(item: dict[str, Any]) -> dict[str, Any]:
    source = " ".join(
        [
            str(item.get("fileName", "")),
            str(item.get("party", "")),
            str(item.get("reference", "")),
            str(item.get("notes", "")),
            str(item.get("rawPreview", "")),
        ]
    )
    detected = detect_type(source)
    current_type = normalize_doc_type(item.get("detectedType"))

    if current_type == "Unknown" and detected["detectedType"] != "Unknown":
        item["detectedType"] = detected["detectedType"]
        item["target"] = detected["target"]

    if not str(item.get("suggestedGlAccount", "")).strip():
        candidate_suggestions = item.get("glSuggestions") or []
        first_candidate = candidate_suggestions[0]["account"] if candidate_suggestions else ""
        item["suggestedGlAccount"] = first_candidate or detected["suggestedGlAccount"] or suggested_account_for_doc_type(item.get("detectedType", "Unknown"))

    if not str(item.get("party", "")).strip():
        item["party"] = clean_words(str(item.get("fileName", "")))

    if detected["evidence"]:
        item.setdefault("evidence", [])
        for line in detected["evidence"]:
            if line not in item["evidence"]:
                item["evidence"].append(line)

    return item
