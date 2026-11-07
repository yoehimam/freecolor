"""Model provider chain for underwater enhancement.

Order of preference:
  1. onnx     — an exported open-source model (WaterNet, FUnIE-GAN, UIE, ...)
                placed in service/models/*.onnx. Runs locally on CPU.
  2. huggingface — Hugging Face Inference API image-to-image endpoint,
                configured with HF_TOKEN + HF_MODEL_ID.
  3. spectral  — built-in numpy restoration, always available.

Every provider returns a PIL image plus metadata; the API exposes the metadata
in response headers so the Node backend can show which engine actually ran.
"""

from __future__ import annotations

import io
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests
from PIL import Image

from spectral import enhance as spectral_enhance, guided_structure_lock

MODEL_DIR = Path(os.getenv("MODEL_DIR", Path(__file__).parent / "models"))
MAX_EDGE = int(os.getenv("MAX_EDGE", "3600"))


@dataclass
class Enhanced:
    image: Image.Image
    provider: str
    model: str
    ms: int


class Provider:
    name = "base"
    model = "unknown"

    def available(self) -> bool:
        return False

    def run(self, img: Image.Image, strength: float) -> Image.Image:  # pragma: no cover
        raise NotImplementedError


class SpectralProvider(Provider):
    name = "spectral"
    model = "udcp-retinex-lab-v2"

    def available(self) -> bool:
        return True

    def run(self, img: Image.Image, strength: float) -> Image.Image:
        return spectral_enhance(img, strength)


class OnnxProvider(Provider):
    """Runs any NCHW RGB image-to-image ONNX export found in models/."""

    name = "onnx"

    def __init__(self) -> None:
        self.session = None
        self.error: Optional[str] = None
        self.input_size = int(os.getenv("ONNX_INPUT_SIZE", "256"))
        self._load()

    def _find_model(self) -> Optional[Path]:
        explicit = os.getenv("ONNX_MODEL_PATH")
        if explicit:
            path = Path(explicit)
            return path if path.exists() else None
        if MODEL_DIR.is_dir():
            candidates = sorted(MODEL_DIR.glob("*.onnx"))
            if candidates:
                return candidates[0]
        return None

    def _load(self) -> None:
        path = self._find_model()
        if not path:
            return
        try:
            import onnxruntime as ort  # type: ignore

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
            self.session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
            self.model = path.stem
        except Exception as exc:  # missing runtime or bad export
            self.error = str(exc)
            self.session = None

    def available(self) -> bool:
        return self.session is not None

    def run(self, img: Image.Image, strength: float) -> Image.Image:
        import numpy as np  # local import keeps module import cheap

        assert self.session is not None
        inp = self.session.get_inputs()[0]
        shape = inp.shape
        h = shape[2] if len(shape) > 2 and isinstance(shape[2], int) else self.input_size
        w = shape[3] if len(shape) > 3 and isinstance(shape[3], int) else self.input_size

        small = img.convert("RGB").resize((w, h), Image.BILINEAR)
        arr = np.asarray(small, dtype=np.float32) / 255.0
        tensor = np.transpose(arr, (2, 0, 1))[None, ...]

        started = time.time()
        outputs = self.session.run(None, {inp.name: tensor})
        _ = time.time() - started

        out = outputs[0]
        if out.ndim == 4:
            out = out[0]
        out = np.transpose(out, (1, 2, 0))
        if out.max() > 1.5:
            out = out / 255.0
        out = np.clip(out, 0.0, 1.0)

        restored = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), mode="RGB")
        return guided_structure_lock(img.convert("RGB"), restored, strength)


class HuggingFaceProvider(Provider):
    """Proxies an image-to-image call to the HF Inference API."""

    name = "huggingface"

    def __init__(self) -> None:
        self.token = os.getenv("HF_TOKEN", "").strip()
        self.model = os.getenv("HF_MODEL_ID", "").strip()
        self.base = os.getenv("HF_BASE_URL", "https://router.huggingface.co/hf-inference").rstrip("/")
        self.legacy = "https://api-inference.huggingface.co"

    def available(self) -> bool:
        return bool(self.token and self.model)

    def _post(self, base: str, payload: bytes, timeout: int = 90) -> requests.Response:
        return requests.post(
            f"{base}/models/{self.model}",
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "image/png",
                "Content-Type": "application/octet-stream",
            },
            data=payload,
            timeout=timeout,
        )

    def run(self, img: Image.Image, strength: float) -> Image.Image:
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="PNG")
        payload = buf.getvalue()

        response = self._post(self.base, payload)
        if response.status_code == 404:
            # older accounts/models still live on the legacy host
            response = self._post(self.legacy, payload)
        if response.status_code == 503:
            # model cold start: one retry with the advertised wait
            try:
                wait = float(response.json().get("estimated_time", 8))
            except Exception:
                wait = 8.0
            time.sleep(min(20.0, max(1.0, wait)))
            response = self._post(self.base, payload)

        if response.status_code >= 400:
            detail = response.text[:200].replace("\n", " ")
            raise RuntimeError(f"HF {response.status_code}: {detail}")

        result = Image.open(io.BytesIO(response.content)).convert("RGB")
        return guided_structure_lock(img.convert("RGB"), result, strength)


class Registry:
    def __init__(self) -> None:
        self.providers = [OnnxProvider(), HuggingFaceProvider(), SpectralProvider()]

    def pick(self, requested: str = "") -> Provider:
        wanted = (requested or os.getenv("PROVIDER", "")).strip().lower()
        if wanted:
            for provider in self.providers:
                if provider.name == wanted and provider.available():
                    return provider
            raise RuntimeError(f"provider '{wanted}' tidak tersedia")
        for provider in self.providers:
            if provider.available():
                return provider
        return self.providers[-1]

    def describe(self) -> list[dict]:
        out = []
        for provider in self.providers:
            item = {
                "name": provider.name,
                "model": provider.model,
                "available": provider.available(),
            }
            error = getattr(provider, "error", None)
            if error:
                item["error"] = error[:160]
            out.append(item)
        return out


def prepare(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    longest = max(img.size)
    if longest > MAX_EDGE:
        scale = MAX_EDGE / float(longest)
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    return img
