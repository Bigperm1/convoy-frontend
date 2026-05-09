"""
Thin async wrapper over the Supabase REST API (PostgREST) using the
service role key. We use httpx directly to avoid pulling in the supabase-py
SDK and to keep things simple for our few admin operations.

Service role key bypasses RLS, so this module MUST only be called from
trusted server-side code (FastAPI endpoints behind auth gates).
"""
from __future__ import annotations
import os
import logging
from typing import Any, Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger("supabase_admin")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_ENABLED = bool(SUPABASE_URL and SERVICE_ROLE_KEY)

_REST = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""


def _headers(prefer: Optional[str] = None) -> dict:
    h = {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        h["Prefer"] = prefer
    return h


async def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10.0)


async def upsert_row(table: str, row: dict, on_conflict: str = "id") -> Optional[dict]:
    """INSERT ... ON CONFLICT UPDATE via PostgREST. Returns the inserted/updated row."""
    if not SUPABASE_ENABLED:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(
                f"{_REST}/{table}?on_conflict={on_conflict}",
                json=row,
                headers=_headers("resolution=merge-duplicates,return=representation"),
            )
            if r.status_code >= 400:
                log.warning("supabase upsert %s failed %s: %s", table, r.status_code, r.text[:200])
                return None
            data = r.json()
            return data[0] if isinstance(data, list) and data else data
    except Exception as e:
        log.warning("supabase upsert %s exception: %s", table, e)
        return None


async def insert_row(table: str, row: dict) -> Optional[dict]:
    if not SUPABASE_ENABLED:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(
                f"{_REST}/{table}",
                json=row,
                headers=_headers("return=representation"),
            )
            if r.status_code >= 400:
                log.warning("supabase insert %s failed %s: %s", table, r.status_code, r.text[:200])
                return None
            data = r.json()
            return data[0] if isinstance(data, list) and data else data
    except Exception as e:
        log.warning("supabase insert %s exception: %s", table, e)
        return None


async def update_row(table: str, row_id: str, patch: dict) -> Optional[dict]:
    if not SUPABASE_ENABLED:
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.patch(
                f"{_REST}/{table}?id=eq.{row_id}",
                json=patch,
                headers=_headers("return=representation"),
            )
            if r.status_code >= 400:
                log.warning("supabase update %s failed %s: %s", table, r.status_code, r.text[:200])
                return None
            data = r.json()
            return data[0] if isinstance(data, list) and data else data
    except Exception as e:
        log.warning("supabase update %s exception: %s", table, e)
        return None


async def delete_row(table: str, row_id: str) -> bool:
    if not SUPABASE_ENABLED:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.delete(
                f"{_REST}/{table}?id=eq.{row_id}",
                headers=_headers(),
            )
            return r.status_code < 400
    except Exception as e:
        log.warning("supabase delete %s exception: %s", table, e)
        return False


async def select_rows(table: str, query: str = "") -> list[dict]:
    """Generic select. `query` is a PostgREST query string e.g. 'community_id=eq.<uuid>&order=created_at.desc'."""
    if not SUPABASE_ENABLED:
        return []
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            url = f"{_REST}/{table}"
            if query:
                url += f"?{query}"
            r = await c.get(url, headers=_headers())
            if r.status_code >= 400:
                log.warning("supabase select %s failed %s: %s", table, r.status_code, r.text[:200])
                return []
            data = r.json()
            return data if isinstance(data, list) else []
    except Exception as e:
        log.warning("supabase select %s exception: %s", table, e)
        return []
