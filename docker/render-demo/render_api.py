"""Render Compute API client with HMAC-SHA256 authentication.

Implements the signing algorithm specified at https://otoyinc.mintlify.app/
for the Dispersed Network API (https://api.compute.x.io).
"""

import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

RENDER_BASE_URL = "https://api.compute.x.io"
REQUEST_TIMEOUT = 30


def _sort_json(obj: Any) -> Any:
    """Recursively sort JSON keys for deterministic HMAC signatures."""
    if isinstance(obj, dict):
        return {k: _sort_json(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_sort_json(item) for item in obj]
    return obj


def _canonical_body(body: dict[str, Any] | None) -> str:
    """Canonicalize request body: sorted keys, compact JSON."""
    if body is None:
        return ""
    sorted_body = _sort_json(body)
    return json.dumps(sorted_body, separators=(",", ":"))


def _canonical_query(params: dict[str, str] | None) -> str:
    """Canonicalize query string: sorted keys, RFC 3986 encoding."""
    if not params:
        return ""
    sorted_items = sorted(params.items())
    return "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted_items)


class RenderClient:
    """HMAC-authenticated client for the Render Compute API."""

    def __init__(
        self,
        public_key: str,
        secret_key: str,
        base_url: str = RENDER_BASE_URL,
    ) -> None:
        self.public_key = public_key
        self.secret_key = secret_key
        self.base_url = base_url.rstrip("/")

    def _sign(
        self,
        method: str,
        path: str,
        query: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, str]:
        """Compute HMAC-SHA256 signature and return auth headers."""
        timestamp = str(int(time.time() * 1000))
        nonce = os.urandom(16).hex()

        query_string = _canonical_query(query)
        canonical_body = _canonical_body(body)
        body_hash = hashlib.sha256(canonical_body.encode()).hexdigest()

        canonical = (
            f"{self.public_key}|{timestamp}|{nonce}|{method}|{path}"
            f"|{query_string}|{body_hash}"
        )

        signature = hmac.new(
            self.secret_key.encode(),
            canonical.encode(),
            hashlib.sha256,
        ).hexdigest()

        return {
            "X-API-Key": self.public_key,
            "X-Time": timestamp,
            "X-Nonce": nonce,
            "X-Signature": signature,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _request(
        self,
        method: str,
        path: str,
        query: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        headers = self._sign(method, path, query, body)
        url = self.base_url + path
        if query:
            # Use the same RFC 3986 encoding as the signed canonical string
            url += "?" + _canonical_query(query)

        content = _canonical_body(body) if body is not None else None

        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.request(method, url, headers=headers, content=content)
            if resp.status_code >= 400:
                logger.error(
                    "Render API error: %s %s -> %d: %s",
                    method, path, resp.status_code, resp.text[:500],
                )
            resp.raise_for_status()
            if resp.status_code == 204 or not resp.content:
                return {}
            try:
                return resp.json()
            except ValueError:
                logger.error(
                    "Render API returned non-JSON: %s %s -> %d: %s",
                    method, path, resp.status_code, resp.text[:200],
                )
                raise

    # -- GPU Registry --

    async def list_gpus(
        self,
        only_available: bool = False,
        min_vram_gb: float | None = None,
    ) -> Any:
        query: dict[str, str] = {"limit": "50"}
        if only_available:
            query["filter[only_available]"] = "true"
        if min_vram_gb is not None:
            query["filter[min_vram_gb]"] = str(min_vram_gb)
        return await self._request("GET", "/v1/gpu-registry", query)

    # -- Jobs --

    async def list_jobs(
        self,
        status: str | None = None,
        task: str | None = None,
    ) -> Any:
        query: dict[str, str] = {"limit": "50", "sort": "-created_at"}
        if status:
            query["filter[status]"] = status
        if task:
            query["filter[task]"] = task
        return await self._request("GET", "/v1/jobs", query)

    async def get_job(self, uuid: str) -> Any:
        return await self._request("GET", f"/v1/jobs/{uuid}")

    async def create_job(
        self,
        title: str,
        task: str,
        image: str,
        port: int,
        gpu_name: str = "RTX 4090",
        gpu_count: int = 1,
        env: dict[str, str] | None = None,
        sshkey: str | None = None,
        extra_ports: list[int] | None = None,
    ) -> Any:
        ports = [port] + (extra_ports or [])

        # Render treats image and tag as separate fields
        image_name = image
        tag = "latest"
        if ":" in image:
            image_name, tag = image.rsplit(":", 1)

        body: dict[str, Any] = {
            "title": title,
            "task": task,
            "gpu_name": gpu_name,
            "gpu_count": gpu_count,
            "max_timeout_run_ms": None if task == "PERSISTENT" else 3600000,
            "max_timeout_start_ms": 1800000,  # 30 min — large image pull on slow nodes
            "parameters": {
                "type": "docker",
                "parameters": {
                    "image": image_name,
                    "tag": tag,
                    "ports": ports,
                },
            },
        }
        if env:
            body["parameters"]["parameters"]["env"] = env
        if sshkey:
            body["parameters"]["parameters"]["sshkey"] = sshkey
        return await self._request("POST", "/v1/jobs", body=body)

    async def cancel_job(self, uuid: str, reason: str = "Stopped by user") -> Any:
        return await self._request(
            "PUT", f"/v1/jobs/{uuid}/cancel", body={"reason": reason}
        )

    # -- Job Runs --

    async def list_job_runs(
        self,
        job_uuid: str | None = None,
        status: str | None = None,
    ) -> Any:
        query: dict[str, str] = {"limit": "10", "sort": "-created_at"}
        if job_uuid:
            query["filter[job_uuid]"] = job_uuid
        if status:
            query["filter[status]"] = status
        return await self._request("GET", "/v1/job-runs", query)

    # -- Recipes --

    async def list_recipes(self, is_official: str | None = None) -> Any:
        query: dict[str, str] = {"limit": "50"}
        if is_official:
            query["filter[is_official]"] = is_official
        return await self._request("GET", "/v1/job-recipes", query)

    async def cook_recipe(
        self, recipe_uuid: str, overrides: dict[str, Any] | None = None
    ) -> Any:
        return await self._request(
            "POST", f"/v1/job-recipes/{recipe_uuid}/cook", body=overrides or {}
        )

    # -- Ledger --

    async def get_transactions(self, limit: int = 10) -> Any:
        return await self._request(
            "GET",
            "/v1/compute/ledger/transactions",
            query={"limit": str(limit), "sort": "-created_at"},
        )
