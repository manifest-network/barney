"""Minimal SDXL-Turbo inference server for the Render GPU network.

The SDXL-Turbo model (~3.5 GB) is downloaded from HuggingFace on first
startup. Subsequent starts use the cached model.
"""

import asyncio
import base64
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from io import BytesIO

import torch
from diffusers import AutoPipelineForText2Image
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

pipe: AutoPipelineForText2Image | None = None
_load_error: str | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global pipe, _load_error
    try:
        logger.info("Loading SDXL-Turbo model...")
        pipe = AutoPipelineForText2Image.from_pretrained(
            "stabilityai/sdxl-turbo",
            torch_dtype=torch.float16,
            variant="fp16",
        ).to("cuda")
        logger.info("Model loaded successfully")
    except Exception as exc:
        _load_error = str(exc)
        logger.error("Failed to load model: %s", exc)
    yield


app = FastAPI(title="Render Inference Server", lifespan=lifespan)


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1)
    width: int = Field(default=512, ge=256, le=1024)
    height: int = Field(default=512, ge=256, le=1024)
    steps: int = Field(default=4, ge=1, le=8)
    seed: int | None = None


class GenerateResponse(BaseModel):
    image: str
    seed: int
    width: int
    height: int


def _run_inference(
    prompt: str, width: int, height: int, steps: int, seed: int | None
) -> tuple[str, int]:
    """Run the diffusion pipeline synchronously. Must not be called from the event loop."""
    if pipe is None:
        raise RuntimeError("Model pipeline not loaded")

    generator = torch.Generator("cuda")
    if seed is not None:
        generator.manual_seed(seed)
    else:
        generator.seed()

    actual_seed = generator.initial_seed()

    result = pipe(
        prompt,
        num_inference_steps=steps,
        width=width,
        height=height,
        guidance_scale=0.0,  # SDXL-Turbo does not use guidance_scale — set to 0.0 per model card
        generator=generator,
    )

    image = result.images[0]
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    b64 = base64.b64encode(buffer.getvalue()).decode()

    return b64, actual_seed


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    if pipe is None:
        detail = f"Model failed to load: {_load_error}" if _load_error else "Model still loading"
        raise HTTPException(503, detail)

    try:
        b64, actual_seed = await asyncio.to_thread(
            _run_inference, req.prompt, req.width, req.height, req.steps, req.seed
        )
    except torch.cuda.OutOfMemoryError as exc:
        raise HTTPException(
            507, "GPU out of memory. Try a smaller image size or fewer steps."
        ) from exc
    except RuntimeError as exc:
        logger.error("Inference failed: %s", exc)
        raise HTTPException(500, f"Inference failed: {exc}") from exc

    return GenerateResponse(image=b64, seed=actual_seed, width=req.width, height=req.height)


@app.get("/health")
async def health() -> JSONResponse:
    if _load_error:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "error": _load_error},
        )
    if pipe is None:
        # 200 — loading is a healthy transitional state (model downloading)
        return JSONResponse(content={"status": "loading"})
    return JSONResponse(content={"status": "ready"})
