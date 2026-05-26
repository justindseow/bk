from typing import Any

from pydantic import BaseModel, Field


class ExportRequest(BaseModel):
    session: dict[str, Any] = Field(
        ...,
        description="Current browser session JSON. The server does not persist it.",
    )


class ExportPlaceholderResponse(BaseModel):
    status: str
    message: str
    received_entity: str | None = None
    received_period: str | None = None
