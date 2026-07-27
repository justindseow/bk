from typing import Any

from pydantic import BaseModel, Field


class ExportRequest(BaseModel):
    session: dict[str, Any] = Field(
        ...,
        description="Current browser session JSON. The server does not persist it.",
    )


class FeedbackRequest(BaseModel):
    tester_name: str = Field(default="", max_length=120)
    tester_email: str = Field(default="", max_length=180)
    rating: str = Field(..., max_length=40)
    ease_of_use: str = Field(..., max_length=80)
    confusing_step: str = Field(default="", max_length=120)
    message: str = Field(..., min_length=5, max_length=3000)
    may_contact: bool = False
    entity: str = Field(default="", max_length=160)
    period: str = Field(default="", max_length=80)
    journal_voucher_finalised: bool = False
    critical_issues: int = 0


class IntakeExtractJsonFile(BaseModel):
    file_name: str = Field(..., min_length=1, max_length=260)
    content_type: str = Field(default="application/octet-stream", max_length=120)
    data_base64: str = Field(..., min_length=1)


class IntakeExtractJsonRequest(BaseModel):
    files: list[IntakeExtractJsonFile]
    upload_lane: str = Field(default="auto", max_length=40)
    client_entity_name: str = Field(default="", max_length=160)
