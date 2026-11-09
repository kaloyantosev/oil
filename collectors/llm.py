"""Thin wrapper around Gemini (google-genai SDK). Returns None whenever AI is unavailable."""
import logging
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)
_client = None


def generate(prompt: str) -> Optional[str]:
    global _client
    if not settings.GEMINI_API_KEY:
        return None
    try:
        if _client is None:
            from google import genai
            _client = genai.Client(api_key=settings.GEMINI_API_KEY)
        resp = _client.models.generate_content(model=settings.GEMINI_MODEL, contents=prompt)
        text = (resp.text or "").strip()
        return text or None
    except Exception as e:
        logger.warning(f"Gemini ({settings.GEMINI_MODEL}) unavailable: {e}")
        return None
