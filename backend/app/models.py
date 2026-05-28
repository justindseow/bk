from typing import Any

from pydantic import BaseModel, Field


class ExportRequest(BaseModel):
    session: dict[str, Any] = Field(
        ...,
        description="Current browser session JSON. The server does not persist it.",
    )
