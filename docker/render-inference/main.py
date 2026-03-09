"""Minimal SDXL-Turbo inference server for the Render GPU network."""

import asyncio
import base64
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from io import BytesIO

import torch
from diffusers import AutoPipelineForText2Image
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateRequest(BaseModel):
    prompt: str
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
    """Run the diffusion pipeline synchronously (called via asyncio.to_thread)."""
    assert pipe is not None

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
        guidance_scale=0.0,  # SDXL-Turbo is distilled for zero-guidance inference
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
    except torch.cuda.OutOfMemoryError:
        raise HTTPException(
            507, "GPU out of memory. Try a smaller image size or fewer steps."
        )
    except RuntimeError as exc:
        logger.error("Inference failed: %s", exc)
        raise HTTPException(500, f"Inference failed: {exc}")

    return GenerateResponse(image=b64, seed=actual_seed, width=req.width, height=req.height)


@app.get("/health")
async def health() -> dict[str, str]:
    if _load_error:
        return {"status": "error", "error": _load_error}
    return {"status": "ready" if pipe is not None else "loading"}
