from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

DocumentType = Literal[
    "Sales Invoice",
    "Sales Summary",
    "Purchase Invoice",
    "Payment Voucher",
    "Receipt",
    "Payroll Summary",
    "Loan / HP Statement",
    "Merchant Statement",
    "Utility Bill",
    "Bank Statement",
    "Unknown",
]

TargetType = Literal["WP1", "WP2", "Ignore"]


class VisionBankRow(BaseModel):
    date: str = ""
    description: str = ""
    reference: str = ""
    money_in: float = 0.0
    money_out: float = 0.0
    balance: float | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)


class GlSuggestion(BaseModel):
    account: str = ""
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    reason: str = ""


class VisionDocumentExtraction(BaseModel):
    document_type: DocumentType = "Unknown"
    target: TargetType = "WP1"
    party: str = ""
    issuer_name: str = ""
    bill_to_name: str = ""
    deliver_to_name: str = ""
    invoice_role: Literal["purchase", "sales", "unknown"] = "unknown"
    document_date: str = ""
    reference: str = ""
    total_amount: float = 0.0
    money_in: float = 0.0
    money_out: float = 0.0
    currency: str = "MYR"
    suggested_gl_account: str = ""
    notes: str = ""
    overall_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    field_confidence: dict[str, float] = Field(default_factory=dict)
    field_evidence: dict[str, list[str]] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    summary: str = ""
    bank_rows: list[VisionBankRow] = Field(default_factory=list)


class VisionDateRecovery(BaseModel):
    document_date: str = ""
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class VisionFieldRecovery(BaseModel):
    document_type: DocumentType = "Unknown"
    invoice_role: Literal["purchase", "sales", "unknown"] = "unknown"
    issuer_name: str = ""
    bill_to_name: str = ""
    deliver_to_name: str = ""
    document_date: str = ""
    reference: str = ""
    total_amount: float = 0.0
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    field_confidence: dict[str, float] = Field(default_factory=dict)
    field_evidence: dict[str, list[str]] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


SmartRevenueDocumentType = Literal[
    "Sales Summary",
    "Sales Invoice",
    "Receipt",
    "Merchant Statement",
    "Unknown",
]


class RevenueClassification(BaseModel):
    document_type: SmartRevenueDocumentType = "Unknown"
    target: TargetType = "WP1"
    suggested_gl_account: str = ""
    gl_suggestions: list[GlSuggestion] = Field(default_factory=list)
    sales_channel: str = ""
    overall_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    summary: str = ""
