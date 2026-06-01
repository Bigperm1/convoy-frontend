from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import uuid
import logging
import asyncio
import secrets as _secrets
import tempfile
import time
import base64
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict

import jwt
import bcrypt
import httpx
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr

import supabase_admin as supa

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("convoy")

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALG = "HS256"

app = FastAPI(title="Convoy API")
api = APIRouter(prefix="/api")
bearer = HTTPBearer(auto_error=False)


# ---------- Models ----------
class RegisterIn(BaseModel):
    email: EmailStr
    password: str
    handle: str
    car_make: Optional[str] = ""
    car_model: Optional[str] = ""
    car_year: Optional[int] = None
    car_color: Optional[str] = ""
    # Silhouette body type — sedan / coupe / suv / sports / truck / hatch / motorcycle / van.
    # Drives which top-down icon shows on the map.
    car_type: Optional[str] = "sedan"

class LoginIn(BaseModel):
    email: EmailStr
    password: str

class CarUpdate(BaseModel):
    handle: Optional[str] = None
    car_make: Optional[str] = None
    car_model: Optional[str] = None
    car_year: Optional[int] = None
    car_color: Optional[str] = None
    car_type: Optional[str] = None
    # Personal best top cruise speed in km/h. Sent from the map screen whenever
    # the user beats their own record (throttled client-side to ≤ 1/min).
    top_speed_record: Optional[float] = None
    # FCM/APNs device push token — saved when the client registers via
    # PUT /api/auth/push-token. Stored here so the /notifications/hail
    # endpoint can look it up by user id.
    push_token: Optional[str] = None

class LocationIn(BaseModel):
    lat: float
    lng: float
    speed: Optional[float] = 0.0
    heading: Optional[float] = 0.0

class HazardIn(BaseModel):
    kind: str
    lat: float
    lng: float
    note: Optional[str] = ""

class TranscribeIn(BaseModel):
    audio_b64: str
    mime: Optional[str] = "audio/m4a"

class PTTIn(BaseModel):
    channel: str  # community id
    audio_b64: str
    duration_ms: int = 0

class CommunityIn(BaseModel):
    name: str
    description: Optional[str] = ""
    is_public: bool = True
    # Optional base64-encoded logo (data URL or raw base64 — frontend stores as data URL).
    # Stored on the community doc so it can be returned via public_community.
    logo_b64: Optional[str] = None
    # Feature toggles — admin decides which sub-systems this community participates in.
    # Defaults are True for full backwards-compat with communities created earlier.
    walkie_enabled: bool = True
    music_enabled: bool = True
    map_enabled: bool = True

class CommunityUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_public: Optional[bool] = None
    logo_b64: Optional[str] = None
    walkie_enabled: Optional[bool] = None
    music_enabled: Optional[bool] = None
    map_enabled: Optional[bool] = None

class RouteIn(BaseModel):
    community_id: str
    name: str
    description: Optional[str] = None
    dest_label: Optional[str] = None
    dest_lat: float
    dest_lng: float
    origin_label: Optional[str] = None
    origin_lat: Optional[float] = None
    origin_lng: Optional[float] = None
    polyline: Optional[str] = None
    scheduled_at: Optional[str] = None  # ISO timestamp


# ---------- Helpers ----------
def hash_pw(pw: str) -> str: return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
def verify_pw(pw: str, hashed: str) -> bool:
    try: return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception: return False

def make_token(user_id: str, email: str) -> str:
    return jwt.encode({"sub": user_id, "email": email,
                       "exp": datetime.now(timezone.utc) + timedelta(days=7), "type": "access"},
                      JWT_SECRET, algorithm=JWT_ALG)

def public_user(u: dict) -> dict:
    return {
        "id": u["id"], "email": u["email"], "handle": u.get("handle", ""),
        "car_make": u.get("car_make", ""), "car_model": u.get("car_model", ""),
        "car_year": u.get("car_year"), "car_color": u.get("car_color", ""),
        "car_type": u.get("car_type", "sedan"),
        "top_speed_record": float(u.get("top_speed_record") or 0),
        "lat": u.get("lat"), "lng": u.get("lng"),
        "heading": u.get("heading", 0), "speed": u.get("speed", 0),
    }

def public_community(c: dict, viewer_id: Optional[str] = None) -> dict:
    members = c.get("members", [])
    pending = c.get("pending_requests", [])
    return {
        "id": c["id"], "name": c["name"], "description": c.get("description", ""),
        "is_public": c.get("is_public", True),
        "logo_b64": c.get("logo_b64"),
        # Feature toggles default to True for legacy docs that pre-date these flags.
        "walkie_enabled": c.get("walkie_enabled", True),
        "music_enabled": c.get("music_enabled", True),
        "map_enabled": c.get("map_enabled", True),
        "admin_id": c.get("admin_id"),
        "admin_handle": c.get("admin_handle", ""),
        "member_count": len(members),
        "pending_count": len(pending),
        "is_admin": viewer_id == c.get("admin_id"),
        "is_member": viewer_id in members if viewer_id else False,
        "is_pending": viewer_id in pending if viewer_id else False,
        "invite_code": c.get("invite_code"),
        "created_at": c.get("created_at"),
    }

async def get_current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if not creds: raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user: raise HTTPException(status_code=401, detail="User not found")
    return user


# ---------- Auth ----------
@api.post("/auth/register")
async def register(body: RegisterIn):
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id, "email": email, "password_hash": hash_pw(body.password),
        "handle": body.handle, "car_make": body.car_make or "", "car_model": body.car_model or "",
        "car_year": body.car_year, "car_color": body.car_color or "",
        "car_type": body.car_type or "sedan",
        "top_speed_record": 0.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "lat": None, "lng": None, "heading": 0, "speed": 0, "last_seen": None,
    }
    await db.users.insert_one(doc)
    return {"token": make_token(user_id, email), "user": public_user(doc)}

@api.post("/auth/login")
async def login(body: LoginIn):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_pw(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"token": make_token(user["id"], email), "user": public_user(user)}

@api.get("/auth/me")
async def me(user=Depends(get_current_user)): return public_user(user)

@api.put("/auth/profile")
async def update_profile(body: CarUpdate, user=Depends(get_current_user)):
    update = {k: v for k, v in body.dict().items() if v is not None}
    if update: await db.users.update_one({"id": user["id"]}, {"$set": update})
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    return public_user(fresh)


# ---------- Push Notification token registration ----------
# Saved when the client calls `getDevicePushTokenAsync()` on app launch
# (see frontend/app/(app)/_layout.tsx). The value is an FCM token on Android
# and an APNs token on iOS — both are looked up later by /notifications/hail.
# We persist both `push_token` and `push_platform` so the relay knows which
# upstream channel to use, and so we can revoke tokens by platform if needed.
class PushTokenBody(BaseModel):
    token: str
    platform: str  # "android" | "ios"


@api.put("/auth/push-token")
async def save_push_token(body: PushTokenBody, user=Depends(get_current_user)):
    """Persist the device push token + platform for the authenticated user.

    Idempotent — the client may call this on every cold start since tokens
    can rotate. We just overwrite the existing fields.
    """
    if not body.token or not body.token.strip():
        raise HTTPException(status_code=400, detail="token required")
    if body.platform not in ("ios", "android", "web"):
        # `web` will never deliver via push but we accept it so the call
        # doesn't 4xx on devs running in the browser preview.
        raise HTTPException(status_code=400, detail="Invalid platform")
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"push_token": body.token, "push_platform": body.platform}},
    )
    return {"ok": True}


# ---------- Location ----------
@api.post("/location")
async def update_location(body: LocationIn, user=Depends(get_current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {
        "lat": body.lat, "lng": body.lng, "speed": body.speed, "heading": body.heading,
        "last_seen": datetime.now(timezone.utc).isoformat(),
    }})
    await ws_manager.broadcast({"type": "location", "user_id": user["id"], "handle": user.get("handle", ""),
                                "lat": body.lat, "lng": body.lng, "speed": body.speed, "heading": body.heading})
    return {"ok": True}

@api.get("/users/nearby")
async def nearby_users(user=Depends(get_current_user)):
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    cursor = db.users.find({"lat": {"$ne": None}, "last_seen": {"$gte": cutoff}, "id": {"$ne": user["id"]}},
                           {"_id": 0, "password_hash": 0})
    return [public_user(u) for u in await cursor.to_list(200)]


# ---------- Hazards ----------
@api.post("/hazards")
async def create_hazard(body: HazardIn, user=Depends(get_current_user)):
    if body.kind not in ("police", "road", "accident", "traffic"):
        raise HTTPException(status_code=400, detail="Invalid hazard kind")
    h = {
        "id": str(uuid.uuid4()), "kind": body.kind, "lat": body.lat, "lng": body.lng,
        "note": body.note or "", "reporter_id": user["id"], "reporter_handle": user.get("handle", ""),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        "confirms": 1,
    }
    await db.hazards.insert_one(h)
    h.pop("_id", None)
    await ws_manager.broadcast({"type": "hazard", "hazard": h})
    # Mirror into Supabase so clients using Realtime (not just our WebSocket)
    # also pick up the hazard immediately. The fire-and-forget task keeps this
    # endpoint snappy — Supabase latency never blocks the HTTP response.
    asyncio.create_task(supa.upsert_row("hazards", {
        "id": h["id"],
        "kind": h["kind"],
        "lat": h["lat"],
        "lng": h["lng"],
        "reporter_handle": h.get("reporter_handle", ""),
        "created_at": h["created_at"],
        "expires_at": h["expires_at"],
    }))
    return h

@api.get("/hazards")
async def list_hazards(user=Depends(get_current_user)):
    now = datetime.now(timezone.utc).isoformat()
    cursor = db.hazards.find({"expires_at": {"$gte": now}}, {"_id": 0})
    return await cursor.to_list(500)

@api.post("/hazards/{hid}/confirm")
async def confirm_hazard(hid: str, user=Depends(get_current_user)):
    res = await db.hazards.update_one({"id": hid}, {"$inc": {"confirms": 1}})
    if not res.matched_count: raise HTTPException(status_code=404, detail="Not found")
    return await db.hazards.find_one({"id": hid}, {"_id": 0})


@api.post("/hazards/{hid}/dispute")
async def dispute_hazard(hid: str, user=Depends(get_current_user)):
    """Community downvote — increments dispute counter so other clients can hide
    heavily-disputed hazards. Kept for back-compat with older clients; new
    clients call DELETE /hazards/{hid} directly to remove the marker."""
    res = await db.hazards.update_one({"id": hid}, {"$inc": {"disputes": 1}})
    if not res.matched_count: raise HTTPException(status_code=404, detail="Not found")
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    # If the community has voted it down significantly, expire it immediately.
    if h and (h.get("disputes", 0) >= (h.get("confirms", 1) + 2)):
        await db.hazards.update_one({"id": hid}, {"$set": {"expires_at": datetime.now(timezone.utc).isoformat()}})
    return h


@api.delete("/hazards/{hid}")
async def delete_hazard(hid: str, user=Depends(get_current_user)):
    """Delete a hazard outright.

    Triggered by clients when a driver taps "Not there" on the dispute modal.
    The hazard is removed from MongoDB AND mirrored into Supabase so the
    Realtime DELETE event fans out to every other driver's map within ~1.5s.

    Idempotent: 404 → returns {ok: True} (the row is already gone, nothing
    to do, no error to surface to the user).
    """
    # 1. Remove from Mongo (the legacy primary store).
    await db.hazards.delete_one({"id": hid})
    # 2. Mirror into Supabase so all peers' Realtime listeners fire.
    asyncio.create_task(supa.delete_row("hazards", hid))
    return {"ok": True, "id": hid}


# ---------- Communities ----------
@api.post("/communities")
async def create_community(body: CommunityIn, user=Depends(get_current_user)):
    cid = str(uuid.uuid4())
    code = _secrets.token_urlsafe(6)
    doc = {
        "id": cid, "name": body.name, "description": body.description or "",
        "is_public": body.is_public, "admin_id": user["id"], "admin_handle": user.get("handle", ""),
        "members": [user["id"]], "pending_requests": [], "invite_code": code,
        "logo_b64": body.logo_b64,
        "walkie_enabled": body.walkie_enabled,
        "music_enabled": body.music_enabled,
        "map_enabled": body.map_enabled,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.communities.insert_one(doc)
    asyncio.create_task(supa.upsert_row("communities", {
        "id": cid,
        "name": doc["name"],
        "description": doc["description"],
    }))
    return public_community(doc, viewer_id=user["id"])

@api.get("/communities/mine")
async def my_communities(user=Depends(get_current_user)):
    cursor = db.communities.find({"members": user["id"]}, {"_id": 0}).sort("created_at", -1)
    items = await cursor.to_list(200)
    return [public_community(c, viewer_id=user["id"]) for c in items]

@api.get("/communities/search")
async def search_communities(q: str = "", user=Depends(get_current_user)):
    f = {"is_public": True}
    if q:
        f["name"] = {"$regex": q, "$options": "i"}
    cursor = db.communities.find(f, {"_id": 0}).sort("created_at", -1).limit(50)
    items = await cursor.to_list(50)
    return [public_community(c, viewer_id=user["id"]) for c in items]

@api.get("/communities/{cid}")
async def get_community(cid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid}, {"_id": 0})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    # One-time admin backfill — pre-admin-aware communities may have no admin_id.
    # We pick the first member as the de-facto owner so the community isn't
    # left orphaned (no one can edit description / approve requests / etc).
    if not c.get("admin_id") and c.get("members"):
        first_uid = c["members"][0]
        first_user = await db.users.find_one({"id": first_uid}, {"_id": 0, "handle": 1})
        admin_handle = (first_user or {}).get("handle", "")
        await db.communities.update_one({"id": cid}, {"$set": {"admin_id": first_uid, "admin_handle": admin_handle}})
        c["admin_id"] = first_uid
        c["admin_handle"] = admin_handle
    out = public_community(c, viewer_id=user["id"])
    # Always return the full member roster so the Comms screen & Hub detail
    # modal can show "who's in this community" without an extra round-trip.
    # We strip sensitive fields (password_hash, raw email when not admin).
    member_ids = c.get("members", [])
    if member_ids:
        members = await db.users.find({"id": {"$in": member_ids}}, {"_id": 0, "password_hash": 0}).to_list(500)
        is_admin = user["id"] == c.get("admin_id")
        out["members_users"] = [
            {
                "id": u["id"],
                "handle": u.get("handle", ""),
                "car_make": u.get("car_make", ""),
                "car_model": u.get("car_model", ""),
                "car_color": u.get("car_color", ""),
                "car_type": u.get("car_type", ""),
                # Email only visible to the admin (privacy-friendly default).
                "email": u.get("email", "") if is_admin or u["id"] == user["id"] else None,
                "is_admin": u["id"] == c.get("admin_id"),
            }
            for u in members
        ]
    else:
        out["members_users"] = []
    if user["id"] == c.get("admin_id"):
        # Return pending request user details for admin
        pending = c.get("pending_requests", [])
        users = await db.users.find({"id": {"$in": pending}}, {"_id": 0, "password_hash": 0}).to_list(200) if pending else []
        out["pending_users"] = [{"id": u["id"], "handle": u.get("handle", ""), "email": u.get("email", "")} for u in users]
    return out

@api.put("/communities/{cid}")
async def update_community(cid: str, body: CommunityUpdate, user=Depends(get_current_user)):
    """
    Admin-only community edit — supports description, name, public flag, logo
    and per-community feature toggles. Anything left as null on `body` is
    untouched, so the client can ship partial updates (e.g. just description).
    """
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"):
        raise HTTPException(status_code=403, detail="Admin only")
    update_doc = {k: v for k, v in body.dict(exclude_none=True).items()}
    if update_doc:
        await db.communities.update_one({"id": cid}, {"$set": update_doc})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

@api.post("/communities/{cid}/request")
async def request_join(cid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] in c.get("members", []):
        return public_community(c, viewer_id=user["id"])
    await db.communities.update_one({"id": cid}, {"$addToSet": {"pending_requests": user["id"]}})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

@api.post("/communities/{cid}/approve/{uid}")
async def approve_request(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"): raise HTTPException(status_code=403, detail="Admin only")
    await db.communities.update_one({"id": cid}, {
        "$pull": {"pending_requests": uid},
        "$addToSet": {"members": uid},
    })
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

@api.post("/communities/{cid}/reject/{uid}")
async def reject_request(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"): raise HTTPException(status_code=403, detail="Admin only")
    await db.communities.update_one({"id": cid}, {"$pull": {"pending_requests": uid}})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

@api.post("/communities/join")
async def join_via_code(code: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"invite_code": code})
    if not c: raise HTTPException(status_code=404, detail="Invalid code")
    await db.communities.update_one({"id": c["id"]}, {
        "$addToSet": {"members": user["id"]},
        "$pull": {"pending_requests": user["id"]},
    })
    fresh = await db.communities.find_one({"id": c["id"]}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

@api.post("/communities/{cid}/leave")
async def leave_community(cid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] == c.get("admin_id"):
        raise HTTPException(status_code=400, detail="Admin cannot leave; delete instead")
    await db.communities.update_one({"id": cid}, {"$pull": {"members": user["id"]}})
    return {"ok": True}

@api.delete("/communities/{cid}")
async def delete_community(cid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"): raise HTTPException(status_code=403, detail="Admin only")
    await db.communities.delete_one({"id": cid})
    await db.ptt.delete_many({"channel": cid})
    # Cascade delete in Supabase mirror (routes auto-delete via ON DELETE CASCADE)
    asyncio.create_task(supa.delete_row("communities", cid))
    return {"ok": True}


# ---------- Community Routes (Supabase-backed) ----------
# Admin-only writes via the FastAPI backend (uses service role to bypass RLS).
# Reads are done client-side directly against Supabase (anon key) since that
# enables Realtime subscriptions; this endpoint is also provided as a
# server-side alternative for clients without the JS SDK.

async def _require_admin(cid: str, user) -> dict:
    c = await db.communities.find_one({"id": cid}, {"_id": 0})
    if not c: raise HTTPException(status_code=404, detail="Community not found")
    if user["id"] != c.get("admin_id"):
        raise HTTPException(status_code=403, detail="Only the community admin can manage routes")
    # Ensure community exists in Supabase mirror (lazy upsert covers communities created
    # before the mirror was wired up).
    asyncio.create_task(supa.upsert_row("communities", {
        "id": c["id"], "name": c["name"], "description": c.get("description", "") or "",
    }))
    return c


@api.post("/communities/{cid}/routes")
async def create_community_route(cid: str, body: RouteIn, user=Depends(get_current_user)):
    """Admin-only — saves a destination/cruise visible to every community member."""
    if body.community_id != cid:
        raise HTTPException(status_code=400, detail="Path/body community_id mismatch")
    await _require_admin(cid, user)
    if not supa.SUPABASE_ENABLED:
        raise HTTPException(status_code=503, detail="Supabase is not configured")
    row = {
        "community_id": cid,
        "created_by": user.get("handle", "") or "admin",
        "name": body.name,
        "description": body.description,
        "dest_label": body.dest_label,
        "dest_lat": body.dest_lat,
        "dest_lng": body.dest_lng,
        "origin_label": body.origin_label,
        "origin_lat": body.origin_lat,
        "origin_lng": body.origin_lng,
        "polyline": body.polyline,
        "scheduled_at": body.scheduled_at,
        "is_active": True,
    }
    saved = await supa.insert_row("routes", row)
    if not saved:
        raise HTTPException(status_code=502, detail="Could not save route to Supabase")
    return saved


@api.get("/communities/{cid}/routes")
async def list_community_routes(cid: str, user=Depends(get_current_user)):
    """Members-only — list active routes for a community."""
    c = await db.communities.find_one({"id": cid}, {"_id": 0})
    if not c: raise HTTPException(status_code=404, detail="Community not found")
    if user["id"] not in c.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member of this community")
    rows = await supa.select_rows(
        "routes",
        f"community_id=eq.{cid}&is_active=eq.true&order=created_at.desc&limit=100",
    )
    return rows


@api.delete("/communities/{cid}/routes/{rid}")
async def delete_community_route(cid: str, rid: str, user=Depends(get_current_user)):
    """Admin-only — soft-deactivate a route. We set is_active=false (rather than
    a hard delete) so members get a Realtime UPDATE event and any in-flight
    navigation can show a 'route removed' notice."""
    await _require_admin(cid, user)
    updated = await supa.update_row("routes", rid, {"is_active": False})
    if updated is None:
        raise HTTPException(status_code=502, detail="Could not deactivate route")
    return {"ok": True}


# ---------- PTT audio amplification ----------
# Convoy PTT clips are recorded on driver phones, then played back through
# car speakers — often over road noise. expo-av caps playback volume at 1.0
# on both iOS and Android, so even at full system volume the clips can sound
# weak. The fix: amplify on the SERVER, once, when the clip arrives. All
# clients then play the already-loud version at expo-av's normal 1.0 cap.
#
# Pipeline (ffmpeg one-shot):
#   1. Decode the incoming m4a/aac into PCM
#   2. `volume=5.0`     — +14 dB gain (the requested 500%)
#   3. `acompressor`    — soft-knee compressor stops the boosted signal from
#      clipping the +14 dB peaks. Settings match the user-provided spec:
#        threshold -6 dB, knee 3 dB, ratio 4:1, attack 3 ms, release 250 ms
#   4. Re-encode to AAC LC at 96 kbps mono (matches the client's record
#      bitrate at "far" proximity tier — no quality loss vs the source).
#
# Failure mode: if ffmpeg fails for ANY reason (corrupt input, unsupported
# codec, container weirdness), we log and pass the original b64 through
# unmodified. PTT delivery must never be blocked by amplification.

PTT_GAIN_DB = 14.0          # +14 dB ≈ ×5 amplitude (the requested "500% louder")
PTT_COMP_FILTER = (
    "volume={gain}dB,"
    "acompressor=threshold=-6dB:knee=3dB:ratio=4:attack=3:release=250"
).format(gain=PTT_GAIN_DB)


async def amplify_ptt_audio(audio_b64: str) -> str:
    """Boost a base64 m4a clip by ~5× with soft-knee compression. Returns
    the new base64 (or the original on failure)."""
    if not audio_b64 or len(audio_b64) < 64:
        return audio_b64
    try:
        raw = base64.b64decode(audio_b64)
    except Exception:
        return audio_b64

    # Use named temp files so ffmpeg has stable paths to read/write. We can't
    # pipe both directions efficiently because AAC needs a seekable container.
    inp = tempfile.NamedTemporaryFile(suffix=".m4a", delete=False)
    out = tempfile.NamedTemporaryFile(suffix=".m4a", delete=False)
    try:
        inp.write(raw); inp.flush(); inp.close()
        out.close()
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", inp.name,
            "-af", PTT_COMP_FILTER,
            "-c:a", "aac", "-b:a", "96k", "-ac", "1",
            out.name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=4.0)
        except asyncio.TimeoutError:
            proc.kill()
            return audio_b64
        if proc.returncode != 0:
            logger.warning(f"PTT amplify failed: {(stderr or b'').decode()[:200]}")
            return audio_b64
        with open(out.name, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")
    except Exception as e:
        logger.warning(f"PTT amplify exception: {e}")
        return audio_b64
    finally:
        try: os.unlink(inp.name)
        except Exception: pass
        try: os.unlink(out.name)
        except Exception: pass


# ---------- PTT (channel = community id) ----------
@api.post("/ptt")
async def post_ptt(body: PTTIn, user=Depends(get_current_user)):
    # Verify membership
    c = await db.communities.find_one({"id": body.channel})
    if not c or user["id"] not in c.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member of this community")
    # Amplify the clip before we store/broadcast it (Bug 9: comms volume).
    # Boosted clip = louder playback on every device + no client-side change.
    boosted_b64 = await amplify_ptt_audio(body.audio_b64)
    msg = {
        "id": str(uuid.uuid4()), "channel": body.channel, "user_id": user["id"],
        "handle": user.get("handle", ""), "audio_b64": boosted_b64,
        "duration_ms": body.duration_ms, "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.ptt.insert_one(msg)
    msg.pop("_id", None)
    # Live walkie-talkie fan-out — push the FULL audio payload to every other
    # member of this community that's currently connected. We scope to the
    # `members` list (not a global broadcast) so each community's voice traffic
    # stays inside that community. The sender is skipped to avoid hearing their
    # own transmission echo on release.
    members = [uid for uid in c.get("members", []) if uid != user["id"]]
    await ws_manager.broadcast_to_users(members, {"type": "ptt", "message": msg})
    # Push fan-out for members whose app is backgrounded / force-closed (i.e.
    # NOT in the live WS registry) so they still get a lockscreen heads-up and
    # can tap to open the Comms transcript. _send_ptt_push already filters to
    # offline members + no-ops when EMERGENT_PUSH_KEY isn't set. Fire-and-forget
    # so it never blocks the HTTP response or the live WS delivery above.
    asyncio.create_task(_send_ptt_push(members, user.get("handle", ""), body.channel, user["id"]))
    return {"ok": True, "id": msg["id"]}

@api.get("/ptt/{channel}")
async def list_ptt(channel: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": channel})
    if not c or user["id"] not in c.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    cursor = db.ptt.find({"channel": channel}, {"_id": 0}).sort("created_at", -1).limit(20)
    items = await cursor.to_list(20)
    return list(reversed(items))


# ---------- Voice transcribe ----------
async def _transcribe_audio(file_path: str) -> str:
    """
    Run Whisper on a local audio file.

    Provider preference:
      1. OPENAI_API_KEY (direct OpenAI SDK) — works on any host (Railway, Render, Fly, etc.).
      2. EMERGENT_LLM_KEY (Emergent universal key via emergentintegrations) — works inside Emergent.

    Set OPENAI_API_KEY in your deployment env to use a portable, host-agnostic path.
    Either env var is sufficient; if both are present OPENAI_API_KEY wins.
    """
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if openai_key:
        # Direct OpenAI SDK — async client, works on any cloud.
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=openai_key)
        with open(file_path, "rb") as f:
            resp = await client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="json",
                language="en",
            )
        return getattr(resp, "text", "") or ""

    emergent_key = os.environ.get("EMERGENT_LLM_KEY", "").strip()
    if emergent_key:
        from emergentintegrations.llm.openai import OpenAISpeechToText
        stt = OpenAISpeechToText(api_key=emergent_key)
        with open(file_path, "rb") as f:
            resp = await stt.transcribe(file=f, model="whisper-1", response_format="json", language="en")
        return getattr(resp, "text", "") or ""

    raise HTTPException(
        status_code=500,
        detail="No LLM key configured. Set OPENAI_API_KEY (recommended) or EMERGENT_LLM_KEY.",
    )


@api.post("/voice/transcribe")
async def transcribe(body: TranscribeIn, user=Depends(get_current_user)):
    import base64
    try: audio_bytes = base64.b64decode(body.audio_b64)
    except Exception: raise HTTPException(status_code=400, detail="Invalid audio")
    if len(audio_bytes) < 1000:
        raise HTTPException(status_code=400, detail="Audio too short")
    suffix = ".m4a" if "m4a" in (body.mime or "") else ".wav"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(audio_bytes); tmp.flush(); tmp.close()
    try:
        text = await _transcribe_audio(tmp.name)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Whisper failed")
        raise HTTPException(status_code=500, detail=f"Transcribe failed: {e}")
    finally:
        try: os.unlink(tmp.name)
        except Exception: pass

    return _classify_intent(text)


# ---------- TTS (natural-voice navigation prompts) ----------
# Proxies an OpenAI TTS request and returns the audio as base64 MP3 so the
# Expo client can play it through expo-av (native) or an HTMLAudio data URI
# (web). This replaces the robotic expo-speech voice in nav.ts for live
# turn-by-turn guidance. tts-1 (not tts-1-hd) is used for low latency —
# nav prompts must fire within ~1s of the maneuver trigger to feel timely.
class TTSBody(BaseModel):
    text: str
    voice: str = "nova"   # OpenAI voices: alloy / echo / fable / onyx / nova / shimmer


@api.post("/tts")
async def text_to_speech(body: TTSBody, user=Depends(get_current_user)):
    """Convert short navigation text into a natural-voice MP3 (base64)."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not openai_key:
        # Frontend treats 503 as "fall back to expo-speech" — see nav.ts speakOne().
        raise HTTPException(status_code=503, detail="TTS not configured")
    try:
        from openai import AsyncOpenAI, RateLimitError, AuthenticationError, APIStatusError
        client = AsyncOpenAI(api_key=openai_key)
        response = await client.audio.speech.create(
            model="tts-1",
            voice=body.voice or "nova",
            input=text,
            response_format="mp3",
        )
        # OpenAI SDK exposes the raw bytes via `.content` (HttpxBinaryResponseContent).
        audio_bytes = getattr(response, "content", None) or response.read()
        return {"audio_b64": base64.b64encode(audio_bytes).decode("utf-8"), "mime": "audio/mp3"}
    except HTTPException:
        raise
    except RateLimitError as e:
        # Quota exhausted / billing-not-configured / per-minute rate limit hit.
        # Surface this as 503 so nav.ts treats it the same as "TTS not configured"
        # and falls back to expo-speech without a stack trace polluting the logs.
        logger.warning("TTS rate-limit / quota: %s", str(e)[:200])
        raise HTTPException(status_code=503, detail="TTS quota exhausted")
    except AuthenticationError as e:
        logger.warning("TTS auth: %s", str(e)[:200])
        raise HTTPException(status_code=503, detail="TTS auth failed")
    except APIStatusError as e:
        # Catch-all for other 4xx/5xx from OpenAI — still surface as 503 so the
        # frontend silently degrades instead of showing a hard error to the driver.
        logger.warning("TTS OpenAI status %s: %s", getattr(e, "status_code", "?"), str(e)[:200])
        raise HTTPException(status_code=503, detail="TTS unavailable")
    except Exception as e:
        logger.exception("TTS failed")
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")


# ---------- Community music broadcast (admin → all members) ----------
# Admin pushes the currently-playing track to every member of their convoy.
# Members see a toast on their map screen (handled by the 'music_broadcast'
# WebSocket message handler in app/(app)/map.tsx). The endpoint is called
# every 10s while the admin's Music screen has broadcasting toggled on, so
# members who reconnect mid-broadcast still receive the track. `action:stop`
# is a one-shot that clears the toast on every client.
class MusicBroadcastBody(BaseModel):
    action: str                              # "play" | "stop"
    community_id: str                        # the convoy the broadcast is scoped to
    track: Optional[dict] = None             # required when action == "play"


@api.post("/community/broadcast-music")
async def broadcast_music(body: MusicBroadcastBody, user=Depends(get_current_user)):
    if body.action not in ("play", "stop"):
        raise HTTPException(status_code=400, detail="Invalid action")
    community = await db.communities.find_one({"id": body.community_id}, {"_id": 0})
    if not community:
        raise HTTPException(status_code=404, detail="Community not found")
    if community.get("admin_id") != user["id"]:
        raise HTTPException(status_code=403, detail="Only the community admin can broadcast")
    members = community.get("members", [])
    if not members:
        return {"ok": True, "delivered": 0}
    await ws_manager.broadcast_to_users(members, {
        "type": "music_broadcast",
        "action": body.action,
        "track": body.track,
        "broadcaster_handle": user.get("handle", ""),
        "broadcaster_id": user.get("id"),
        "community_id": body.community_id,
    })
    return {"ok": True, "delivered": len(members)}


# ---------- Hail (peer push notification) ----------
# When the user taps the "Hail" button in the PeerModal we want a real push
# notification on the recipient's lockscreen — not just a WebSocket ping
# that's silently dropped when the app is killed. This endpoint:
#   1. Verifies the caller and target share at least one community
#      (prevents spamming random nearby drivers).
#   2. Looks up the target's `push_token` saved by /auth/push-token.
#   3. Fan-out via Emergent Managed Push relay (works in iOS APNs + Android
#      FCM all-states); falls back to a raw WebSocket frame if (a) the relay
#      key is unset (local dev), (b) the target hasn't registered a token, or
#      (c) the relay returns an error. The WS path is what was already wired
#      pre-this-feature, so behavior never regresses.
# Body shape kept thin so the frontend doesn't need to know which community
# context the modal opened in — `community_id` is optional (used only for
# data payload routing, not the share-check).
class HailBody(BaseModel):
    target_user_id: str
    community_id: Optional[str] = None


PUSH_RELAY_URL = "https://integrations.emergentagent.com/api/v1/push/trigger"


async def _send_ptt_push(member_ids, sender_handle: str, channel: str, sender_id: str):
    """Best-effort push fan-out for a PTT transmission.

    Mirrors the Hail push path (Emergent relay). Targets ONLY members who are
    NOT currently connected over the WebSocket — i.e. the app is backgrounded
    or force-closed, which is exactly when the live WS/poll delivery can't
    reach them. Foregrounded members already heard the clip via
    broadcast_to_users, so pushing them too would double-notify.

    Fire-and-forget: never raises, never blocks the /ptt HTTP response. The
    `data.type == "ptt"` payload is what the app's notification handler keys
    on to deep-link into the Comms transcript when tapped.
    """
    push_key = os.environ.get("EMERGENT_PUSH_KEY", "").strip()
    if not push_key or push_key == "placeholder":
        return  # relay not provisioned (local dev) — WS path already handled live delivery
    # "Offline" = not in the live WS registry. Those are the ones that need a push.
    offline = [uid for uid in member_ids if uid not in ws_manager.active]
    if not offline:
        return
    targets = await db.users.find(
        {"id": {"$in": offline}, "push_token": {"$nin": [None, ""]}},
        {"_id": 0, "id": 1, "push_token": 1},
    ).to_list(500)
    if not targets:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            for t in targets:
                payload = {
                    "token": t["push_token"],
                    "title": "🎙 Convoy comms",
                    "body": f"{sender_handle} sent a transmission",
                    "data": {
                        "type": "ptt",
                        "channel": channel,
                        "from_handle": sender_handle,
                        "from_id": sender_id,
                    },
                    "sound": "default",
                }
                try:
                    await client.post(
                        PUSH_RELAY_URL,
                        headers={"X-Push-Key": push_key, "Content-Type": "application/json"},
                        json=payload,
                    )
                except Exception as e:
                    logger.warning(f"PTT push failed for {t.get('id')}: {str(e)[:120]}")
    except Exception as e:
        logger.warning(f"PTT push fan-out error: {str(e)[:120]}")


async def _send_hail_via_ws(target_user_id: str, sender: dict) -> dict:
    """Always-on fallback: raw WebSocket fan-out to the target user.
    Returns the response body shape the HTTP endpoint will use."""
    await ws_manager.broadcast_to_users([target_user_id], {
        "type": "hail",
        "from_handle": sender.get("handle", "Driver"),
        "from_id": sender["id"],
    })
    return {"ok": True, "method": "websocket"}


@api.post("/notifications/hail")
async def hail_peer(body: HailBody, user=Depends(get_current_user)):
    # 1. Verify caller and target share a community. Mongo $all matches docs
    #    whose `members` array contains BOTH user ids.
    shared = await db.communities.find_one({
        "members": {"$all": [user["id"], body.target_user_id]}
    })
    if not shared:
        raise HTTPException(status_code=403, detail="You must be in the same community to hail")

    # 2. Target lookup.
    target = await db.users.find_one({"id": body.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    push_token = target.get("push_token")
    sender_handle = user.get("handle", "A driver")

    # 3. If no token, go straight to WS.
    if not push_token:
        return await _send_hail_via_ws(body.target_user_id, user)

    # 4. Try the Emergent push relay. If anything goes sideways, fall back
    #    to WS — never raise to the caller; the user just tapped a button
    #    expecting some kind of delivery.
    push_key = os.environ.get("EMERGENT_PUSH_KEY", "").strip()
    if not push_key or push_key == "placeholder":
        # Local dev or relay-key not provisioned yet. WS fallback.
        ws_resp = await _send_hail_via_ws(body.target_user_id, user)
        ws_resp["method"] = "websocket_no_key"
        return ws_resp

    payload = {
        "token": push_token,
        "title": f"🚨 Hail from {sender_handle}",
        "body": f"{sender_handle} is hailing you on Convoy",
        "data": {
            "type": "hail",
            "from_id": user["id"],
            "from_handle": sender_handle,
            "community_id": body.community_id or "",
        },
        "sound": "default",
        "badge": 1,
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                PUSH_RELAY_URL,
                headers={"X-Push-Key": push_key, "Content-Type": "application/json"},
                json=payload,
            )
        # Send WS in addition (redundant delivery) so foregrounded clients
        # get the toast even without OS push permission.
        await ws_manager.broadcast_to_users([body.target_user_id], {
            "type": "hail",
            "from_handle": sender_handle,
            "from_id": user["id"],
        })
        return {"ok": True, "method": "push", "status": resp.status_code}
    except Exception as e:
        logger.warning(f"Hail push relay failed, falling back to WS: {e}")
        ws_resp = await _send_hail_via_ws(body.target_user_id, user)
        ws_resp["method"] = "websocket_fallback"
        ws_resp["error"] = str(e)[:120]
        return ws_resp


def _classify_intent(text: str) -> dict:
    """Return {text, intent, query?} for a transcript. Order matters - more specific first."""
    import re
    lt = (text or "").lower().strip().rstrip(".!?,")
    intent = None
    query = None

    # 1. Stop / clear navigation
    if any(p in lt for p in ["stop navigation", "cancel route", "clear route", "stop route",
                              "end navigation", "cancel navigation", "stop directions"]):
        intent = "clear_route"
    # 2. Navigate-to commands → extract destination
    elif any(lt.startswith(p) for p in ["navigate to ", "drive to ", "take me to ",
                                          "directions to ", "go to ", "route to ",
                                          "directions for ", "navigate me to "]):
        m = re.match(r"^(?:navigate(?: me)? to|drive to|take me to|directions to|go to|route to|directions for)\s+(.+)$", lt)
        if m:
            query = m.group(1).strip()
            intent = "navigate_to"
    elif " navigate to " in lt or " drive to " in lt or " take me to " in lt:
        m = re.search(r"(?:navigate(?: me)? to|drive to|take me to|directions to|go to|route to)\s+(.+)$", lt)
        if m:
            query = m.group(1).strip()
            intent = "navigate_to"
    # 3. Hazard reports
    elif "police" in lt or "cop" in lt: intent = "report_police"
    elif "accident" in lt or "crash" in lt: intent = "report_accident"
    elif "hazard" in lt or "debris" in lt or "pothole" in lt: intent = "report_road"
    elif "traffic" in lt or "jam" in lt: intent = "report_traffic"
    # 4. Screen navigation
    elif "talk" in lt or "walkie" in lt or "push to talk" in lt or "ptt" in lt: intent = "open_talk"
    elif "music" in lt or "play song" in lt or "play music" in lt or "spotify" in lt: intent = "open_music"
    elif "carplay" in lt or "drive mode" in lt or "drive screen" in lt: intent = "open_drive"
    elif "hub" in lt or "garage" in lt or "community" in lt or "communities" in lt: intent = "open_hub"
    elif lt == "map" or "open map" in lt or "show map" in lt or "back to map" in lt: intent = "open_map"

    out = {"text": text, "intent": intent}
    if query:
        out["query"] = query
    return out


# NOTE: The legacy Waze-style external alerts proxy (`/api/feed/external`) was
# removed June 2025. The upstream Waze rtproxy endpoints returned 403 to all
# requests and the feature was already hidden in the Layers UI. Hazards are
# now sourced exclusively from our own Supabase mirror + Mongo collection.


@api.get("/directions")
async def directions_proxy(
    origin_lat: float, origin_lng: float,
    dest_lat: float, dest_lng: float,
    avoid_tolls: bool = False,
    avoid_highways: bool = False,
    avoid_ferries: bool = False,
    user=Depends(get_current_user),
):
    """Proxy for the Google Directions API.

    The browser cannot call the Directions REST endpoint directly because Google
    doesn't return CORS headers on it. This route lets the web client fetch a
    multi-route response (with alternates) the same way native does.
    """
    key = os.environ.get("GOOGLE_MAPS_KEY") or os.environ.get("EXPO_PUBLIC_GOOGLE_MAPS_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="Google Maps key not configured")
    avoid_parts = []
    if avoid_tolls: avoid_parts.append("tolls")
    if avoid_highways: avoid_parts.append("highways")
    if avoid_ferries: avoid_parts.append("ferries")
    params = {
        "origin": f"{origin_lat},{origin_lng}",
        "destination": f"{dest_lat},{dest_lng}",
        "mode": "driving",
        "alternatives": "true",
        # Traffic-aware ETAs — `departure_time=now` makes Google return
        # `duration_in_traffic` per route so the client can rank alternatives
        # by current congestion (not free-flow time).
        "departure_time": "now",
        "traffic_model": "best_guess",
        "key": key,
    }
    if avoid_parts:
        params["avoid"] = "|".join(avoid_parts)
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get("https://maps.googleapis.com/maps/api/directions/json", params=params)
            return r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"directions upstream error: {e}")


# ---------- WebSocket ----------
class WSManager:
    def __init__(self):
        self.active: Dict[str, WebSocket] = {}
        self.lock = asyncio.Lock()

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        async with self.lock:
            old = self.active.get(user_id)
            self.active[user_id] = ws
        if old:
            try: await old.close()
            except Exception: pass

    async def disconnect(self, user_id: str):
        async with self.lock: self.active.pop(user_id, None)

    async def broadcast(self, message: dict):
        dead = []
        for uid, ws in list(self.active.items()):
            try: await ws.send_json(message)
            except Exception: dead.append(uid)
        for uid in dead: await self.disconnect(uid)

    async def broadcast_to_users(self, user_ids, message: dict):
        """
        Targeted broadcast — only sends to the given list of user ids.
        Used by PTT so a community's voice traffic stays inside that community
        and doesn't waste bandwidth fanning out to the entire server.
        """
        if not user_ids:
            return
        target = set(user_ids)
        dead = []
        for uid, ws in list(self.active.items()):
            if uid not in target:
                continue
            try: await ws.send_json(message)
            except Exception: dead.append(uid)
        for uid in dead: await self.disconnect(uid)

ws_manager = WSManager()


@app.websocket("/api/ws")
async def ws_endpoint(websocket: WebSocket, token: Optional[str] = None):
    if not token:
        await websocket.close(code=4401); return
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload["sub"]
    except Exception:
        await websocket.close(code=4401); return
    await ws_manager.connect(user_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            mtype = data.get("type")
            if mtype == "ping":
                await websocket.send_json({"type": "pong"})
            elif mtype == "location":
                await ws_manager.broadcast({"type": "location", "user_id": user_id,
                                            "lat": data.get("lat"), "lng": data.get("lng"),
                                            "heading": data.get("heading", 0), "speed": data.get("speed", 0)})
    except WebSocketDisconnect:
        await ws_manager.disconnect(user_id)
    except Exception as e:
        logger.warning(f"WS error: {e}")
        await ws_manager.disconnect(user_id)


@api.get("/")
async def root(): return {"service": "Convoy", "ok": True}


@api.get("/health")
async def api_health(): return {"ok": True, "service": "convoy-api"}


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])


# ---------- Liveness / Readiness probes (NO /api prefix) ----------
# Emergent's Kubernetes ingress / nginx harness probes the root path BEFORE
# routing any /api/* traffic. Without a 200 here the deployment is marked
# unhealthy and the public DNS record is never published, even though the
# uvicorn server itself starts cleanly. Both endpoints below are DB-free
# so they pass even before Mongo is fully warm.
@app.get("/")
async def app_root():
    return {"service": "Convoy", "status": "ok"}


@app.get("/health")
async def app_health():
    return {"ok": True}


@app.get("/healthz")
async def app_healthz():
    # Common K8s convention — some probes use /healthz instead of /health.
    return {"ok": True}


@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.hazards.create_index("expires_at")
    await db.ptt.create_index([("channel", 1), ("created_at", -1)])
    await db.communities.create_index("id", unique=True)
    await db.communities.create_index("invite_code")
    await db.communities.create_index("name")

    # ============================================================
    # Demo / seed data
    # ============================================================
    # By default this fires on every cold start and is what powers the
    # local dev experience (demo@revradar.app, AlexGT, SaraS2K, the two
    # public communities). For TestFlight builds + production deploys
    # we want a CLEAN database so beta testers don't see fake drivers.
    #
    # Set SEED_DEMO_DATA=0 (or "false") in the backend `.env` to skip.
    # Recommended values per environment:
    #   - local dev          → 1 (default)
    #   - staging / TestFlight → 0
    #   - production         → 0
    seed_flag = os.environ.get("SEED_DEMO_DATA", "1").strip().lower()
    if seed_flag in ("0", "false", "no", "off"):
        logger.info("Convoy started (seed skipped: SEED_DEMO_DATA=%s).", seed_flag)
        return

    # Seed demo users
    seeds = [
        {"email": "demo@revradar.app", "password": "demo1234", "handle": "DemoDriver", "car": ("Toyota", "Supra", 1998, "Red")},
        {"email": "alex@revradar.app", "password": "demo1234", "handle": "AlexGT", "car": ("BMW", "M3", 2022, "Blue")},
        {"email": "sara@revradar.app", "password": "demo1234", "handle": "SaraS2K", "car": ("Honda", "S2000", 2005, "Yellow")},
    ]
    user_ids = {}
    for s in seeds:
        existing = await db.users.find_one({"email": s["email"]})
        if not existing:
            uid = str(uuid.uuid4())
            await db.users.insert_one({
                "id": uid, "email": s["email"], "password_hash": hash_pw(s["password"]),
                "handle": s["handle"], "car_make": s["car"][0], "car_model": s["car"][1],
                "car_year": s["car"][2], "car_color": s["car"][3],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "lat": None, "lng": None, "heading": 0, "speed": 0, "last_seen": None,
            })
            user_ids[s["email"]] = uid
        else:
            user_ids[s["email"]] = existing["id"]

    # Seed a sample public community owned by Demo
    if not await db.communities.find_one({"name": "Bay Area Drivers"}):
        demo_id = user_ids.get("demo@revradar.app")
        if demo_id:
            await db.communities.insert_one({
                "id": str(uuid.uuid4()),
                "name": "Bay Area Drivers",
                "description": "Weekend cruises around the Bay. JDM friendly.",
                "is_public": True,
                "admin_id": demo_id,
                "admin_handle": "DemoDriver",
                "members": [demo_id, user_ids.get("alex@revradar.app", "")],
                "pending_requests": [],
                "invite_code": _secrets.token_urlsafe(6),
                "created_at": datetime.now(timezone.utc).isoformat(),
            })
    if not await db.communities.find_one({"name": "Mountain Pass Crew"}):
        demo_id = user_ids.get("sara@revradar.app")
        if demo_id:
            await db.communities.insert_one({
                "id": str(uuid.uuid4()),
                "name": "Mountain Pass Crew",
                "description": "Touge runs and canyon meets",
                "is_public": True,
                "admin_id": demo_id,
                "admin_handle": "SaraS2K",
                "members": [demo_id],
                "pending_requests": [],
                "invite_code": _secrets.token_urlsafe(6),
                "created_at": datetime.now(timezone.utc).isoformat(),
            })

    logger.info("Convoy started.")


@app.on_event("shutdown")
async def shutdown(): client.close()
