import os
import smtplib
from email.message import EmailMessage

from .models import FeedbackRequest


class FeedbackEmailNotConfigured(RuntimeError):
    pass


def _env_bool(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def feedback_email_configured() -> bool:
    required = [
        "FEEDBACK_TO_EMAIL",
        "SMTP_HOST",
        "SMTP_USERNAME",
        "SMTP_PASSWORD",
    ]
    return all(os.getenv(name) for name in required)


def send_feedback_email(feedback: FeedbackRequest) -> None:
    to_email = os.getenv("FEEDBACK_TO_EMAIL", "").strip()
    smtp_host = os.getenv("SMTP_HOST", "").strip()
    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    smtp_username = os.getenv("SMTP_USERNAME", "").strip()
    smtp_password = os.getenv("SMTP_PASSWORD", "")
    from_email = os.getenv("SMTP_FROM_EMAIL", smtp_username).strip()
    subject_prefix = os.getenv("FEEDBACK_SUBJECT_PREFIX", "MacroByte BK Tool Feedback").strip()
    use_tls = _env_bool("SMTP_USE_TLS", True)

    if not feedback_email_configured() or not from_email:
        raise FeedbackEmailNotConfigured("Feedback email is not configured.")

    subject = f"{subject_prefix} - {feedback.rating}"
    body = f"""New MacroByte BK Tool feedback

Tester name: {feedback.tester_name or "Not provided"}
Tester email: {feedback.tester_email or "Not provided"}
May contact: {"Yes" if feedback.may_contact else "No"}

Rating: {feedback.rating}
Ease of use: {feedback.ease_of_use}
Most confusing step: {feedback.confusing_step or "Not specified"}

Entity: {feedback.entity or "Not provided"}
Period: {feedback.period or "Not provided"}
Journal Voucher finalised: {"Yes" if feedback.journal_voucher_finalised else "No"}
Critical validation issues: {feedback.critical_issues}

Feedback:
{feedback.message}
"""

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = from_email
    message["To"] = to_email
    if feedback.tester_email:
        message["Reply-To"] = feedback.tester_email
    message.set_content(body)

    with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as smtp:
        if use_tls:
            smtp.starttls()
        smtp.login(smtp_username, smtp_password)
        smtp.send_message(message)
