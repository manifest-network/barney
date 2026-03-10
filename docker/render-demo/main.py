"""Image Generator web app — deployed on Manifest, inference on Render.

Serves a web UI for text-to-image generation. Uses the Render Compute API
(OTOY Dispersed Network) to run a GPU inference server, then proxies
generation requests to it.
"""

import asyncio
import logging
import os
import time
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
INFERENCE_SSH_PUBKEY = os.environ.get("RENDER_SSH_PUBKEY", "")
IDLE_SHUTDOWN_MINUTES = int(os.environ.get("RENDER_IDLE_SHUTDOWN_MINUTES", "10"))

# In-memory tracking of the active inference job.
# Lost on restart — a running Render job will become orphaned.
_active_job_uuid: str | None = None
_last_activity: float = 0.0  # time.monotonic() of last generation request
_idle_task: asyncio.Task | None = None  # background idle checker

STATIC_DIR = Path(__file__).parent / "static"


async def _idle_shutdown_loop() -> None:
    """Background task that stops the inference job after idle timeout."""
    global _active_job_uuid, _idle_task
    while _active_job_uuid:
        await asyncio.sleep(60)  # check every minute
        if not _active_job_uuid:
            break
        idle_seconds = time.monotonic() - _last_activity
        if idle_seconds >= IDLE_SHUTDOWN_MINUTES * 60:
            logger.info(
                "Idle for %d min — stopping inference job %s",
                IDLE_SHUTDOWN_MINUTES, _active_job_uuid,
            )
            try:
                await render.cancel_job(_active_job_uuid, reason="Idle timeout")
            except Exception as exc:
                logger.warning("Failed to stop idle job: %s", exc)
            _active_job_uuid = None
            break
    _idle_task = None


def _start_idle_timer() -> None:
    global _last_activity, _idle_task
    _last_activity = time.monotonic()
    if _idle_task is None or _idle_task.done():
        _idle_task = asyncio.create_task(_idle_shutdown_loop())


def _touch_activity() -> None:
    global _last_activity
    _last_activity = time.monotonic()


def _cancel_idle_timer() -> None:
    global _idle_task
    if _idle_task and not _idle_task.done():
        _idle_task.cancel()
        _idle_task = None


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


@app.get("/api/debug/config")
async def debug_config() -> dict:
    return {
        "RENDER_API_KEY": "set" if _render_api_key else "missing",
        "RENDER_SECRET_KEY": "set" if _render_secret_key else "missing",
        "RENDER_INFERENCE_IMAGE": INFERENCE_IMAGE or "missing",
        "RENDER_SSH_PUBKEY": INFERENCE_SSH_PUBKEY[:20] + "..." if INFERENCE_SSH_PUBKEY else "missing",
        "RENDER_INFERENCE_PORT": INFERENCE_PORT,
        "active_job_uuid": _active_job_uuid,
    }


@app.get("/api/debug/runs")
async def debug_runs() -> dict:
    if not _active_job_uuid:
        return {"error": "no active job"}
    return await render.list_job_runs(job_uuid=_active_job_uuid)


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

    # Check if the tracked job is actually still active on Render
    if _active_job_uuid:
        try:
            job = await render.get_job(_active_job_uuid)
            if job.get("status") in ("PENDING", "ASSIGNED", "RUNNING"):
                raise HTTPException(409, "An inference job is already active. Stop it first.")
            # Job is terminal — clear stale reference
            logger.info("Clearing stale job reference %s (status: %s)", _active_job_uuid, job.get("status"))
            _active_job_uuid = None
        except httpx.HTTPError:
            # Can't reach Render — clear stale reference and allow redeploy
            _active_job_uuid = None

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
        sshkey=INFERENCE_SSH_PUBKEY or None,
        extra_ports=[22] if INFERENCE_SSH_PUBKEY else None,
    )

    _active_job_uuid = job.get("uuid")
    logger.info("Deployed inference job: %s", _active_job_uuid)
    _start_idle_timer()
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

    node_urls = await _get_node_urls() if job.get("status") == "RUNNING" else []
    idle_seconds = int(time.monotonic() - _last_activity) if _last_activity else 0
    idle_shutdown_at = IDLE_SHUTDOWN_MINUTES * 60 - idle_seconds if _active_job_uuid else None
    return {
        "status": job.get("status", "unknown"),
        "job": job,
        "node_urls": node_urls,
        "idle_seconds_remaining": max(0, idle_shutdown_at) if idle_shutdown_at is not None else None,
    }


@app.post("/api/stop")
async def stop_inference(req: StopRequest) -> dict:
    global _active_job_uuid

    if not _active_job_uuid:
        raise HTTPException(400, "No active inference job")

    result = await render.cancel_job(_active_job_uuid, reason=req.reason)

    logger.info("Stopped inference job: %s", _active_job_uuid)
    _active_job_uuid = None
    _cancel_idle_timer()
    return result


@app.post("/api/generate")
async def generate_image(req: GenerateRequest) -> dict:
    if not _active_job_uuid:
        raise HTTPException(400, "No inference server running. Deploy one first.")

    _touch_activity()

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
    except Exception as exc:
        logger.debug("Inference health check failed: %s", exc)
        return {"status": "unavailable"}


async def _get_node_urls() -> list[dict]:
    """Fetch node_urls for the active job's first running run."""
    if not _active_job_uuid:
        return []

    try:
        runs = await render.list_job_runs(
            job_uuid=_active_job_uuid, status="RUNNING"
        )
    except httpx.HTTPError as exc:
        logger.warning("Failed to fetch job runs for %s: %s", _active_job_uuid, exc)
        return []

    if not runs.get("data"):
        return []

    return runs["data"][0].get("node_urls", [])


def _format_node_url(node: dict) -> str | None:
    hostname = node.get("hostname")
    port = node.get("port")
    if not hostname or port is None:
        return None
    # Render uses "tcp" protocol — map to http for HTTP services
    proto = node.get("protocol", "tcp")
    scheme = "http" if proto == "tcp" else proto
    return f"{scheme}://{hostname}:{port}"


async def _resolve_inference_url() -> str | None:
    """Get the HTTP URL of the running inference server from Render."""
    node_urls = await _get_node_urls()
    if not node_urls:
        return None

    # Render maps container ports to random external ports.
    # The container port is in the "description" field, the external port in "port".
    match = next(
        (n for n in node_urls if n.get("description") == str(INFERENCE_PORT)),
        node_urls[0],
    )
    return _format_node_url(match)


# -- Static files --
# Serve index.html at root, static assets for everything else


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
