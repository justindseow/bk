from __future__ import annotations

import json
import os
from urllib import error, request
from typing import Any


def configured_provider() -> str:
    explicit = os.getenv("AI_PROVIDER", "").strip().lower()
    if explicit in {"openai", "openrouter", "anthropic", "gemini"}:
        return explicit
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.getenv("GEMINI_API_KEY"):
        return "gemini"
    if os.getenv("OPENROUTER_API_KEY"):
        return "openrouter"
    return "openai"


def provider_api_key() -> str:
    provider = configured_provider()
    if provider == "openrouter":
        return os.getenv("OPENROUTER_API_KEY", "").strip()
    if provider == "gemini":
        return os.getenv("GEMINI_API_KEY", "").strip()
    return os.getenv("OPENAI_API_KEY", "").strip()


def provider_base_url() -> str:
    provider = configured_provider()
    if provider == "openrouter":
        return os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip()
    if provider == "gemini":
        return os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai").strip()
    return os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").strip()


def provider_headers() -> dict[str, str]:
    api_key = provider_api_key()
    if not api_key:
        raise RuntimeError(f"{configured_provider()} API key is not configured.")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if configured_provider() == "openrouter":
        referer = os.getenv("OPENROUTER_HTTP_REFERER", "").strip()
        title = os.getenv("OPENROUTER_APP_TITLE", "").strip()
        if referer:
            headers["HTTP-Referer"] = referer
        if title:
            headers["X-Title"] = title
    return headers


def vision_model() -> str:
    provider = configured_provider()
    if provider == "anthropic":
        return os.getenv("ANTHROPIC_VISION_MODEL", "claude-sonnet-4-6").strip()
    if provider == "openrouter":
        return os.getenv("OPENROUTER_VISION_MODEL", "google/gemini-2.5-flash").strip()
    if provider == "gemini":
        return os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash").strip()
    return os.getenv("OPENAI_VISION_MODEL", "gpt-4o").strip()


def classifier_model() -> str:
    provider = configured_provider()
    if provider == "anthropic":
        return os.getenv("ANTHROPIC_CLASSIFIER_MODEL", "claude-haiku-4-5-20251001").strip()
    if provider == "openrouter":
        return os.getenv("OPENROUTER_MODEL", os.getenv("OPENAI_CLASSIFIER_MODEL", "openai/gpt-4o-mini")).strip()
    if provider == "gemini":
        return os.getenv("GEMINI_CLASSIFIER_MODEL", "gemini-2.0-flash").strip()
    return os.getenv("OPENAI_CLASSIFIER_MODEL", "gpt-4o-mini").strip()


def can_use_provider() -> bool:
    if configured_provider() == "anthropic":
        return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())
    return bool(provider_api_key())


def provider_limit_warning(message: str) -> str:
    lowered = (message or "").lower()
    provider = configured_provider()
    provider_name = {"openrouter": "OpenRouter", "anthropic": "Claude", "gemini": "Gemini"}.get(provider, "AI provider")

    if "http 402" in lowered or ("balance" in lowered and "file" in lowered):
        return f"{provider_name} scan limit reached. AI vision could not read this file. Top up balance or retry later."
    if "http 403" in lowered and ("key limit exceeded" in lowered or "monthly limit" in lowered):
        return f"{provider_name} scan limit reached. AI vision could not read this file. Top up balance or retry later."
    if "http 429" in lowered or "rate limit" in lowered or "quota" in lowered:
        return f"{provider_name} rate limit reached. AI vision could not read this file right now. Retry later."
    if "overloaded" in lowered or "http 529" in lowered:
        return f"{provider_name} is temporarily overloaded. Retry later."
    return ""


# ── Anthropic (Claude) backend ────────────────────────────────────────────────

def _convert_content_for_anthropic(content: str | list[dict[str, Any]]) -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return content
    converted: list[dict[str, Any]] = []
    for item in content:
        if item.get("type") == "text":
            converted.append({"type": "text", "text": item["text"]})
        elif item.get("type") == "image_url":
            url: str = (item.get("image_url") or {}).get("url", "")
            if url.startswith("data:"):
                header, _, b64data = url.partition(",")
                media_type = header.split(":")[1].split(";")[0]
                converted.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": b64data},
                })
    return converted


def _post_anthropic_completion(
    *,
    model: str,
    messages: list[dict[str, Any]],
    schema_name: str,
    schema: dict[str, Any],
    temperature: float = 0.0,
) -> dict[str, Any]:
    try:
        import anthropic as _anthropic
    except ImportError:
        raise RuntimeError("anthropic package is required: pip install anthropic")

    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not configured.")

    system_parts: list[str] = []
    anthropic_messages: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "system":
            if isinstance(content, str) and content:
                system_parts.append(content)
        else:
            anthropic_messages.append({
                "role": role,
                "content": _convert_content_for_anthropic(content),
            })

    kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": 4096,
        "tools": [{
            "name": schema_name,
            "description": f"Extract structured {schema_name} data from the document.",
            "input_schema": schema,
        }],
        "tool_choice": {"type": "tool", "name": schema_name},
        "messages": anthropic_messages,
    }
    if system_parts:
        kwargs["system"] = "\n\n".join(system_parts)
    if temperature:
        kwargs["temperature"] = temperature

    client = _anthropic.Anthropic(api_key=api_key)
    try:
        response = client.messages.create(**kwargs)
    except _anthropic.RateLimitError as exc:
        raise RuntimeError(f"rate limit reached: {exc}") from exc
    except _anthropic.APIStatusError as exc:
        raise RuntimeError(f"anthropic API request failed with HTTP {exc.status_code}: {exc.message}") from exc
    except Exception as exc:
        raise RuntimeError(f"anthropic API request failed: {exc}") from exc

    for block in response.content:
        if block.type == "tool_use":
            return {
                "choices": [{
                    "message": {"content": json.dumps(block.input)}
                }]
            }

    raise RuntimeError("anthropic API returned no tool_use block.")


# ── Shared entry points ───────────────────────────────────────────────────────

def post_chat_completion(
    *,
    model: str,
    messages: list[dict[str, Any]],
    schema_name: str,
    schema: dict[str, Any],
    extra_body: dict[str, Any] | None = None,
    temperature: float = 0.0,
) -> dict[str, Any]:
    if configured_provider() == "anthropic":
        return _post_anthropic_completion(
            model=model,
            messages=messages,
            schema_name=schema_name,
            schema=strict_json_schema(schema),
            temperature=temperature,
        )
    normalized_schema = strict_json_schema(schema)
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": schema_name,
                "strict": False,
                "schema": normalized_schema,
            },
        },
    }
    if extra_body:
        payload.update(extra_body)
    return post_json("/chat/completions", payload)


def post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    base_url = provider_base_url().rstrip("/")
    url = f"{base_url}{path}"
    timeout_seconds = float(os.getenv("AI_HTTP_TIMEOUT_SECONDS", "120"))
    request_body = json.dumps(payload).encode("utf-8")
    http_request = request.Request(url, data=request_body, headers=provider_headers(), method="POST")
    try:
        with request.urlopen(http_request, timeout=timeout_seconds) as response:
            raw_body = response.read().decode("utf-8")
    except error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"{configured_provider()} API request failed with HTTP {exc.code}: {error_body}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"{configured_provider()} API request failed: {exc.reason}") from exc

    try:
        return json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{configured_provider()} API returned invalid JSON.") from exc


def completion_message_text(response: dict[str, Any]) -> str:
    choices = response.get("choices") or []
    if not choices:
        raise RuntimeError(f"{configured_provider()} API returned no choices.")

    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text_value = item.get("text")
                if text_value:
                    parts.append(str(text_value))
        if parts:
            return "\n".join(parts).strip()
    raise RuntimeError(f"{configured_provider()} API returned no text content.")


def strict_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    def normalize(node: Any) -> Any:
        if isinstance(node, dict):
            normalized = {key: normalize(value) for key, value in node.items()}
            if normalized.get("type") == "object":
                normalized.setdefault("additionalProperties", False)
                properties = normalized.get("properties")
                if isinstance(properties, dict) and properties:
                    normalized["required"] = list(properties.keys())
            return normalized
        if isinstance(node, list):
            return [normalize(item) for item in node]
        return node

    return normalize(schema)
