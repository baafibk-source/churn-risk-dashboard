"""Fixed paths and settings. Model files are only ever read from these paths."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = BASE_DIR / "artifacts"
STATIC_DIR = BASE_DIR / "static"

MODEL_PATH = ARTIFACTS_DIR / "model.json"
CALIBRATION_PATH = ARTIFACTS_DIR / "calibration.json"
PORTFOLIO_PATH = ARTIFACTS_DIR / "portfolio.json"
REPORT_PATH = ARTIFACTS_DIR / "model_report.json"

# Risk bands on CALIBRATED probability (test-set churn rate is 26.5%).
HIGH_RISK = 0.50
MEDIUM_RISK = 0.25

# Assistant: off unless HF_TOKEN is set.
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-oss-120b")
LLM_URL = "https://router.huggingface.co/v1/chat/completions"
LLM_TIMEOUT_S = 30.0
ASSISTANT_PER_IP_PER_MINUTE = int(os.getenv("ASSISTANT_PER_IP_PER_MINUTE", "4"))
ASSISTANT_PER_IP_PER_DAY = int(os.getenv("ASSISTANT_PER_IP_PER_DAY", "20"))
ASSISTANT_GLOBAL_PER_DAY = int(os.getenv("ASSISTANT_GLOBAL_PER_DAY", "300"))
QUESTION_MAX_CHARS = 280
ANSWER_MAX_CHARS = 1200

MAX_BODY_BYTES = 4096

# Pages allowed to embed this app in an iframe (Hugging Face Spaces).
FRAME_ANCESTORS = "'self' https://huggingface.co https://*.hf.space"


def hf_token() -> str | None:
    """Read at call time so tests can toggle it; never logged or returned."""
    token = os.getenv("HF_TOKEN", "").strip()
    return token or None
