"""Local Xserver CAPTCHA solver using the bundled Keras model.

Model: repo-root/xserver_captcha.keras
  Input : (60, 300, 3) RGB, values in [0, 1]
  Output: (19, 11)   softmax over 10 digits + 1 CTC blank

We do a simple CTC greedy decode: argmax per timestep,
remove consecutive duplicates, then remove the blank class.

Blank convention here: class index == 10 (last class, num_classes - 1),
which is the standard convention for CTC in Keras.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import re
import threading
from typing import Optional

log = logging.getLogger(__name__).info

_MODEL_LOCK = threading.Lock()
_MODEL = None
_BLANK_INDEX = 10  # last class in an 11-way softmax


def _default_model_path() -> str:
    """Locate xserver_captcha.keras. Order: env var, repo root, cwd."""
    env = os.environ.get("CAPTCHA_MODEL_PATH")
    if env and os.path.exists(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "xserver_captcha.keras"),
        os.path.abspath(os.path.join(here, "..", "xserver_captcha.keras")),
        os.path.abspath("xserver_captcha.keras"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    raise FileNotFoundError(
        "xserver_captcha.keras not found. Set CAPTCHA_MODEL_PATH or place the file at repo root."
    )


def _load_model():
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        # Silence TF logs a bit.
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
        import tensorflow as tf  # type: ignore

        path = _default_model_path()
        log(f"[captcha_solver] loading model from {path}")
        _MODEL = tf.keras.models.load_model(path, compile=False)
        log("[captcha_solver] model loaded")
    return _MODEL


def _decode_data_url(data_url: str) -> bytes:
    """Accept either a raw base64 payload or a 'data:image/...;base64,XXX' URL."""
    m = re.match(r"^data:([^;]+);base64,(.*)$", data_url.strip(), flags=re.DOTALL)
    if m:
        return base64.b64decode(m.group(2))
    # Fallback: assume the whole string is base64.
    return base64.b64decode(data_url)


def _prepare_image(image_bytes: bytes):
    from PIL import Image  # type: ignore
    import numpy as np  # type: ignore

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    # Model expects 60 (H) x 300 (W) x 3.
    img = img.resize((300, 60), Image.BILINEAR)
    arr = np.asarray(img, dtype="float32") / 255.0
    arr = arr.reshape(1, 60, 300, 3)
    return arr


def _ctc_greedy_decode(probs) -> str:
    """probs: shape (T, C). Return decoded digit string."""
    import numpy as np  # type: ignore

    best = np.argmax(probs, axis=-1)  # (T,)
    out = []
    prev = -1
    for k in best.tolist():
        if k != prev and k != _BLANK_INDEX:
            out.append(str(k))
        prev = k
    return "".join(out)


def solve(data_url_or_b64: str) -> Optional[str]:
    """Solve a data-URL captcha image locally. Returns digit string or None on failure."""
    try:
        image_bytes = _decode_data_url(data_url_or_b64)
    except Exception as e:
        log(f"[captcha_solver] base64 decode failed: {e}")
        return None
    try:
        arr = _prepare_image(image_bytes)
    except Exception as e:
        log(f"[captcha_solver] image prep failed: {e}")
        return None
    try:
        model = _load_model()
    except Exception as e:
        log(f"[captcha_solver] model load failed: {e}")
        return None
    try:
        # Model output shape: (1, 19, 11)
        probs = model.predict(arr, verbose=0)[0]
        text = _ctc_greedy_decode(probs)
        return text or None
    except Exception as e:
        log(f"[captcha_solver] inference failed: {e}")
        return None
