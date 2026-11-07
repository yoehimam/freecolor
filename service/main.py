"""FreeColor Spectral Service — FastAPI.

POST /enhance   multipart: file=<image>, strength=0..1, provider=optional
                -> image/jpeg with X-Provider / X-Model / X-Ms headers
GET  /health    -> provider availability
GET  /          -> short description

Run:
    service/.venv/Scripts/python.exe service/main.py
    (or) uvicorn main:app --host 127.0.0.1 --port 8799 --app-dir service
"""

from __future__ import annotations

import asyncio
import hmac
import io
import os
import time
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

from providers import Registry, prepare

VERSION = "1.0.0"
PORT = int(os.getenv("SPECTRAL_PORT", "8799"))
TOKEN = os.getenv("SPECTRAL_TOKEN", "").strip()
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 64_000_000  # Guard against decompression bombs

app = FastAPI(title="FreeColor Spectral Service", version=VERSION)
registry = Registry()


def authorize(token: Optional[str]) -> None:
    if not TOKEN:
        return
    if not token or not hmac.compare_digest(token.encode("utf-8"), TOKEN.encode("utf-8")):
        raise HTTPException(status_code=401, detail="token tidak valid")


def _process_sync(payload: bytes, strength: float, provider: str) -> tuple[bytes, str, str, int, int, int]:
    try:
        image = Image.open(io.BytesIO(payload))
        image.load()
    except Image.DecompressionBombError:
        raise HTTPException(status_code=413, detail="resolusi gambar terlalu besar")
    except Exception:
        raise HTTPException(status_code=422, detail="gambar tidak bisa dibaca")

    image = prepare(image)
    started = time.time()

    try:
        chosen = registry.pick(provider)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    clamped_strength = max(0.05, min(1.0, strength))
    try:
        result = chosen.run(image, clamped_strength)
    except Exception as exc:
        # A dead model must not break the editor: fall back to spectral.
        fallback = registry.providers[-1]
        if chosen.name == fallback.name:
            raise HTTPException(status_code=500, detail="gagal memproses gambar pada engine spektral")
        result = fallback.run(image, clamped_strength)
        chosen = fallback

    elapsed = int((time.time() - started) * 1000)
    out = io.BytesIO()
    result.save(out, format="JPEG", quality=96, subsampling=0, optimize=True)
    return out.getvalue(), chosen.name, str(chosen.model)[:80], elapsed, result.width, result.height


@app.get("/")
def root() -> dict:
    return {
        "service": "freecolor-spectral",
        "version": VERSION,
        "endpoints": ["POST /enhance", "GET /health"],
    }


@app.get("/health")
def health() -> JSONResponse:
    providers = registry.describe()
    active = next((p["name"] for p in providers if p["available"]), None)
    return JSONResponse(
        {
            "ok": bool(active),
            "version": VERSION,
            "active": active,
            "providers": providers,
            "maxEdge": int(os.getenv("MAX_EDGE", "2600")),
        }
    )


@app.post("/enhance")
async def enhance(
    file: UploadFile = File(...),
    strength: float = Form(0.75),
    provider: str = Form(""),
    x_spectral_token: Optional[str] = Header(default=None),
) -> Response:
    authorize(x_spectral_token)

    payload = await file.read(MAX_UPLOAD_BYTES + 1)
    if not payload:
        raise HTTPException(status_code=400, detail="file kosong")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file terlalu besar")

    jpeg_bytes, prov_name, model_name, elapsed, width, height = await asyncio.to_thread(
        _process_sync, payload, strength, provider
    )

    return Response(
        content=jpeg_bytes,
        media_type="image/jpeg",
        headers={
            "X-Provider": prov_name,
            "X-Model": model_name,
            "X-Ms": str(elapsed),
            "X-Width": str(width),
            "X-Height": str(height),
            "Cache-Control": "no-store",
        },
    )


if __name__ == "__main__":
    print(f"[spectral] http://127.0.0.1:{PORT}")
    for item in registry.describe():
        print(f"[spectral] provider {item['name']:<12} available={item['available']} model={item['model']}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
