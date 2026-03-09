"""Minimal SDXL-Turbo inference server for the Render GPU network.

The SDXL-Turbo model (~3.5 GB) is downloaded from HuggingFace on first
startup. Subsequent starts use the cached model.
"""

import asyncio
import base64
import glob
import logging
import os
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

MODEL_ID = os.environ.get("MODEL_ID", "stabilityai/sdxl-turbo")

pipe: AutoPipelineForText2Image | None = None
_load_error: str | None = None


def _find_local_snapshot(model_id: str) -> str | None:
    """Find a local HF cache snapshot for the given model ID."""
    hf_home = os.environ.get("HF_HOME", "")
    if not hf_home:
        return None
    # HF cache layout: {HF_HOME}/hub/models--{org}--{name}/snapshots/{hash}/
    cache_name = "models--" + model_id.replace("/", "--")
    pattern = os.path.join(hf_home, "hub", cache_name, "snapshots", "*", "model_index.json")
    matches = glob.glob(pattern)
    if matches:
        return os.path.dirname(matches[0])
    return None


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global pipe, _load_error
    try:
        # Prefer local snapshot if available (baked into image), fall back to HF download
        local_path = _find_local_snapshot(MODEL_ID)
        source = local_path or MODEL_ID
        logger.info("Loading model from %s ...", source)
        pipe = AutoPipelineForText2Image.from_pretrained(
            source,
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
