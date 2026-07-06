"""Local Xserver CAPTCHA solver using the bundled Keras model.

Model: repo-root/xserver_captcha.keras (from GitHub30/captcha-cloudrun)
  Input : (60, 300, 3) RGB, values in [0, 1]
  Output: (19, 11)   softmax over 10 digits + 1 CTC blank

This implementation mirrors the reference upstream at
https://github.com/GitHub30/captcha-cloudrun/blob/main/main.py so that our
local prediction produces the same digits as the (formerly used) cloudrun
endpoint. Key details:

  1. Use tf.image.decode_png (not decode_jpeg). The Xserver CAPTCHA bytes
     always start with the PNG magic number `\x89PNG\r\n\x1a\n`
     ("iVBORw..." in base64) even though the data URL is labelled
     `image/jpeg`. Decoding with the correct codec matters for accuracy.
  2. Use tf.image.resize with [60, 300] (height, width) so the resize
     kernel matches the one used during training (bilinear via TF).
  3. Use tf.keras.backend.ctc_decode(preds, ..., greedy=True) for the
     standard CTC greedy decode. Blank tokens are returned as -1 by that
     op, so we filter with `c >= 0` (do NOT hardcode blank = num_classes-1).
"""
from __future__ import annotations

import logging
import os
import re
import threading
from typing import Optional

log = logging.getLogger(__name__).info

_MODEL_LOCK = threading.Lock()
_MODEL = None


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


def _extract_b64_payload(data_url_or_b64: str) -> str:
    """Return just the base64 payload from either a full data URL or raw b64."""
    s = data_url_or_b64.strip()
    m = re.match(r"^data:[^;]+;base64,(.*)$", s, flags=re.DOTALL)
    if m:
        return m.group(1)
    return s


def solve(data_url_or_b64: str) -> Optional[str]:
    """Solve a data-URL CAPTCHA image locally.

    Returns the decoded digit string, or None on any failure.
    """
    try:
        payload = _extract_b64_payload(data_url_or_b64)
    except Exception as e:
        log(f"[captcha_solver] payload extract failed: {e}")
        return None

    try:
        model = _load_model()
    except Exception as e:
        log(f"[captcha_solver] model load failed: {e}")
        return None

    try:
        import tensorflow as tf  # type: ignore

        # tf.io.decode_base64 requires URL-safe base64 (- and _ instead of + /).
        url_safe = payload.translate(str.maketrans({"+": "-", "/": "_"}))
        raw = tf.io.decode_base64(url_safe)
        # Bytes are actually PNG even though the data URL says image/jpeg.
        img = tf.image.decode_png(raw, channels=3)
        img = tf.image.resize(img, [60, 300]) / 255.0
        batch = tf.expand_dims(img, 0)  # (1, 60, 300, 3)

        preds = model(batch)  # (1, 19, 11)

        # Prefer the classic tf.keras.backend.ctc_decode (matches reference impl).
        try:
            input_len = tf.fill([tf.shape(preds)[0]], tf.shape(preds)[1])
            decoded = tf.keras.backend.ctc_decode(
                preds, input_length=input_len, greedy=True
            )[0][0]
            code = "".join(str(int(c)) for c in decoded.numpy()[0] if int(c) >= 0)
        except Exception as _cd_err:
            # Fallback for Keras 3 environments where backend.ctc_decode is missing.
            log(f"[captcha_solver] backend.ctc_decode unavailable ({_cd_err}); falling back to tf.nn.ctc_greedy_decoder")
            # tf.nn.ctc_greedy_decoder expects (T, B, C).
            logits = tf.transpose(preds, [1, 0, 2])
            seq_len = tf.fill([tf.shape(logits)[1]], tf.shape(logits)[0])
            sparse, _ = tf.nn.ctc_greedy_decoder(
                inputs=tf.math.log(tf.maximum(logits, 1e-12)),
                sequence_length=seq_len,
            )
            dense = tf.sparse.to_dense(sparse[0], default_value=-1).numpy()
            code = "".join(str(int(c)) for c in dense[0] if int(c) >= 0)

        return code or None
    except Exception as e:
        log(f"[captcha_solver] inference failed: {e}")
        return None
