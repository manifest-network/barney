"""Image Generator web app — deployed on Manifest, inference on Render.

Serves a web UI for text-to-image generation. Uses the Render Compute API
(OTOY Dispersed Network) to run a GPU inference server, then proxies
generation requests to it.
"""

import logging
import os
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from render_api import RenderClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Render Image Generator")

_render_api_key = os.environ.get("RENDER_API_KEY", "")
_render_secret_key = os.environ.get("RENDER_SECRET_KEY", "")
if not _render_api_key or not _render_secret_key:
    logger.warning(
        "RENDER_API_KEY or RENDER_SECRET_KEY not set. "
        "All Render API calls will fail with authentication errors."
    )

render = RenderClient(public_key=_render_api_key, secret_key=_render_secret_key)


@app.exception_handler(httpx.HTTPStatusError)
async def render_api_error_handler(
    _request: Request, exc: httpx.HTTPStatusError
) -> JSONResponse:
    return JSONResponse(
        status_code=exc.response.status_code,
        content={"detail": str(exc)},
    )


@app.exception_handler(httpx.HTTPError)
async def render_network_error_handler(
    _request: Request, exc: httpx.HTTPError
) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={"detail": f"Cannot reach Render API: {exc}"},
    )


INFERENCE_IMAGE = os.environ.get("RENDER_INFERENCE_IMAGE", "")
INFERENCE_PORT = int(os.environ.get("RENDER_INFERENCE_PORT", "8000"))
INFERENCE_TIMEOUT = int(os.environ.get("RENDER_INFERENCE_TIMEOUT", "120"))

# In-memory tracking of the active inference job.
# Lost on restart — a running Render job will become orphaned.
_active_job_uuid: str | None = None

STATIC_DIR = Path(__file__).parent / "static"


# -- Models --


class DeployRequest(BaseModel):
    gpu_name: str = "RTX 4090"
    image: str | None = None


class StopRequest(BaseModel):
    reason: str = "Stopped by user"


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=1000)
    width: int = Field(default=512, ge=256, le=1024)
    height: int = Field(default=512, ge=256, le=1024)
    steps: int = Field(default=4, ge=1, le=8)
    seed: int | None = None


# -- API routes --


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/gpus")
async def list_gpus() -> dict:
    return await render.list_gpus(only_available=True)


@app.get("/api/recipes")
async def list_recipes() -> dict:
    return await render.list_recipes(is_official="true")


@app.get("/api/jobs")
async def list_jobs() -> dict:
    return await render.list_jobs(status="PENDING,ASSIGNED,RUNNING")


@app.post("/api/deploy")
async def deploy_inference(req: DeployRequest) -> dict:
    global _active_job_uuid

    image = req.image or INFERENCE_IMAGE
    if not image:
        raise HTTPException(400, "No inference image configured. Set RENDER_INFERENCE_IMAGE.")

    job = await render.create_job(
        title="Image Generator Inference",
        task="PERSISTENT",
        image=image,
        port=INFERENCE_PORT,
        gpu_name=req.gpu_name,
        gpu_count=1,
    )

    _active_job_uuid = job.get("uuid")
    logger.info("Deployed inference job: %s", _active_job_uuid)
    return job


@app.get("/api/status")
async def inference_status() -> dict:
    if not _active_job_uuid:
        return {"status": "not_deployed", "job": None, "node_urls": []}

    try:
        job = await render.get_job(_active_job_uuid)
    except httpx.HTTPError as exc:
        logger.warning("Failed to fetch job %s: %s", _active_job_uuid, exc)
        return {"status": "unknown", "job": None, "node_urls": []}

    result: dict = {"status": job.get("status", "unknown"), "job": job, "node_urls": []}

    if job.get("status") == "RUNNING":
        try:
            runs = await render.list_job_runs(
                job_uuid=_active_job_uuid, status="RUNNING"
            )
            if runs.get("data"):
                result["node_urls"] = runs["data"][0].get("node_urls", [])
        except httpx.HTTPError as exc:
            logger.warning("Failed to list job runs for %s: %s", _active_job_uuid, exc)

    return result


@app.post("/api/stop")
async def stop_inference(req: StopRequest) -> dict:
    global _active_job_uuid

    if not _active_job_uuid:
        raise HTTPException(400, "No active inference job")

    result = await render.cancel_job(_active_job_uuid, reason=req.reason)

    logger.info("Stopped inference job: %s", _active_job_uuid)
    _active_job_uuid = None
    return result


@app.post("/api/generate")
async def generate_image(req: GenerateRequest) -> dict:
    if not _active_job_uuid:
        raise HTTPException(400, "No inference server running. Deploy one first.")

    # Resolve the inference server URL from the active job's node_urls
    inference_url = await _resolve_inference_url()
    if not inference_url:
        raise HTTPException(503, "Inference server not ready — no node URLs available yet")

    try:
        async with httpx.AsyncClient(timeout=INFERENCE_TIMEOUT) as client:
            resp = await client.post(
                f"{inference_url}/generate",
                json=req.model_dump(),
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.TimeoutException as exc:
        raise HTTPException(504, "Inference request timed out") from exc
    except httpx.ConnectError as exc:
        raise HTTPException(
            502, "Cannot reach inference server. It may have crashed or is still starting."
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(exc.response.status_code, f"Inference error: {exc}") from exc


@app.get("/api/inference-health")
async def inference_health() -> dict:
    inference_url = await _resolve_inference_url()
    if not inference_url:
        return {"status": "unavailable"}

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{inference_url}/health")
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPStatusError, httpx.ConnectError, httpx.TimeoutException):
        return {"status": "unavailable"}


def _format_node_url(node: dict) -> str:
    proto = node.get("protocol", "https")
    return f"{proto}://{node['hostname']}:{node['port']}"


async def _resolve_inference_url() -> str | None:
    """Get the HTTP URL of the running inference server from Render."""
    if not _active_job_uuid:
        return None

    try:
        runs = await render.list_job_runs(
            job_uuid=_active_job_uuid, status="RUNNING"
        )
    except httpx.HTTPError as exc:
        logger.warning("Failed to resolve inference URL for job %s: %s", _active_job_uuid, exc)
        return None

    if not runs.get("data"):
        return None

    node_urls = runs["data"][0].get("node_urls", [])
    if not node_urls:
        return None

    # Prefer a URL matching the expected inference port, fall back to first
    match = next(
        (n for n in node_urls if n.get("port") == INFERENCE_PORT),
        node_urls[0],
    )
    return _format_node_url(match)


# -- Static files --
# Serve index.html at root, static assets for everything else


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
