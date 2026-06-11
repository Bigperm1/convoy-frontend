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
from fastapi.responses import RedirectResponse
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


# ---------- Apple Music (MusicKit) developer token ----------
# Signs a short-lived ES256 "developer token" from our MusicKit private key
# (.p8). The .p8 is a SECRET and lives only here (Render env vars), never in
# the app. The app fetches a token from GET /api/apple-music/developer-token,
# then exchanges it for an Apple Music *user* token on-device via MusicKit.
#
# Required env vars (set these in Render):
#   APPLE_MUSIC_KEY_ID   - the 10-char Key ID of the MusicKit key
#   APPLE_MUSIC_TEAM_ID  - your Apple Developer Team ID (the token issuer)
#   APPLE_MUSIC_P8       - the FULL contents of the AuthKey_XXXX.p8 file
#                          (PEM incl. the BEGIN/END PRIVATE KEY lines). Literal
#                          "\n" sequences are accepted and normalized.
_apple_music_token_cache: Dict[str, object] = {"token": None, "exp": 0.0}

def _build_apple_music_developer_token() -> str:
    key_id = os.environ.get("APPLE_MUSIC_KEY_ID", "").strip()
    team_id = os.environ.get("APPLE_MUSIC_TEAM_ID", "").strip()
    p8 = os.environ.get("APPLE_MUSIC_P8", "")
    if not (key_id and team_id and p8):
        raise HTTPException(status_code=503, detail="Apple Music is not configured on the server")
    # Render keeps multi-line values fine, but tolerate escaped newlines too.
    private_key = p8.replace("\\n", "\n").strip()
    issued = int(time.time())
    # Apple allows developer tokens up to 6 months; use ~150 days and refresh
    # well before expiry (see the cache check below).
    expires = issued + 150 * 24 * 60 * 60
    try:
        token = jwt.encode(
            {"iss": team_id, "iat": issued, "exp": expires},
            private_key,
            algorithm="ES256",
            headers={"alg": "ES256", "kid": key_id},
        )
    except Exception as e:
        logger.error("Apple Music token signing failed: %s", e)
        raise HTTPException(status_code=500, detail="Could not sign Apple Music developer token")
    _apple_music_token_cache["token"] = token
    _apple_music_token_cache["exp"] = float(expires)
    return token

@api.get("/apple-music/developer-token")
async def apple_music_developer_token():
    """Return a cached MusicKit developer token, re-signing only near expiry."""
    cached = _apple_music_token_cache.get("token")
    exp = float(_apple_music_token_cache.get("exp") or 0)
    if cached and exp - time.time() > 24 * 60 * 60:
        return {"token": cached}
    return {"token": _build_apple_music_developer_token()}


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

class ForgotPasswordIn(BaseModel):
    email: EmailStr

class ResetPasswordIn(BaseModel):
    email: EmailStr
    code: str
    new_password: str

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

# Admin rights = the owner (admin_id) OR any co-admin (up to 2). Owner-only
# actions (manage co-admins, transfer ownership, delete) check admin_id directly.
def _is_comm_admin(c: dict, uid: Optional[str]) -> bool:
    return bool(uid) and (uid == c.get("admin_id") or uid in c.get("co_admins", []))

def public_community(c: dict, viewer_id: Optional[str] = None) -> dict:
    members = c.get("members", [])
    pending = c.get("pending_requests", [])
    co_admins = c.get("co_admins", [])
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
        "co_admins": co_admins,
        "member_count": len(members),
        "pending_count": len(pending),
        # is_admin = owner or co-admin; is_owner = the single owner only.
        "is_admin": _is_comm_admin(c, viewer_id),
        "is_owner": viewer_id == c.get("admin_id"),
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


# ---------- Password reset (emails a 6-digit code) ----------
RESEND_API_URL = "https://api.resend.com/emails"

async def _send_email(to: str, subject: str, html: str) -> bool:
    """Send a transactional email via Resend (HTTP API, no SMTP needed).
    Returns True on success. No-ops gracefully (returns False) if
    RESEND_API_KEY isn't set so the reset flow degrades instead of erroring.
    To switch providers later, only this function needs to change."""
    key = os.environ.get("RESEND_API_KEY", "").strip()
    if not key:
        logger.warning("RESEND_API_KEY not set — reset email NOT sent to %s", to)
        return False
    sender = os.environ.get("EMAIL_FROM", "Convoy <onboarding@resend.dev>")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                RESEND_API_URL,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"from": sender, "to": [to], "subject": subject, "html": html},
            )
        if r.status_code >= 400:
            logger.warning("Resend error %s: %s", r.status_code, r.text[:200])
            return False
        return True
    except Exception as e:
        logger.warning("Resend send failed: %s", str(e)[:160])
        return False


@api.post("/auth/forgot-password")
async def forgot_password(body: ForgotPasswordIn):
    """Email a 6-digit reset code. ALWAYS returns {ok: True} regardless of
    whether the address exists, so we never reveal which emails are registered."""
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if user:
        code = f"{_secrets.randbelow(1000000):06d}"
        expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
        await db.users.update_one({"id": user["id"]}, {"$set": {
            "reset_code": code, "reset_code_expires": expires,
        }})
        html = (
            "<div style='font-family:sans-serif;max-width:420px'>"
            "<h2 style='color:#111'>Convoy password reset</h2>"
            "<p>Use this code to reset your password:</p>"
            f"<p style='font-size:30px;font-weight:800;letter-spacing:6px;color:#111'>{code}</p>"
            "<p style='color:#666'>This code expires in 15 minutes. "
            "If you didn't request it, you can ignore this email.</p>"
            "</div>"
        )
        await _send_email(email, "Your Convoy reset code", html)
    return {"ok": True}


@api.post("/auth/reset-password")
async def reset_password(body: ResetPasswordIn):
    """Verify the 6-digit code and set a new password."""
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not user.get("reset_code") or user.get("reset_code") != body.code.strip():
        raise HTTPException(status_code=400, detail="Invalid or expired code")
    expires = user.get("reset_code_expires")
    try:
        if not expires or datetime.fromisoformat(expires) < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Invalid or expired code")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid or expired code")
    if len(body.new_password or "") < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"password_hash": hash_pw(body.new_password)},
         "$unset": {"reset_code": "", "reset_code_expires": ""}},
    )
    return {"ok": True}


# ---------- Owner-only admin ----------
# The app owner can view the roster and mint password-reset codes to relay to
# locked-out testers by hand (Discord/text) - no email or SMS provider needed.
# Strictly gated to the owner account by email; every other user gets 403.
OWNER_EMAIL = "jwellsmorton@gmail.com"

def _is_owner(user: dict) -> bool:
    return (user.get("email") or "").strip().lower() == OWNER_EMAIL

@api.get("/admin/users")
async def admin_list_users(user=Depends(get_current_user)):
    if not _is_owner(user):
        raise HTTPException(status_code=403, detail="Owner only")
    cursor = db.users.find({}, {"_id": 0, "password_hash": 0, "reset_code": 0, "reset_code_expires": 0}).sort("created_at", -1)
    users = await cursor.to_list(2000)
    return [{
        "id": u.get("id"),
        "email": u.get("email", ""),
        "handle": u.get("handle", ""),
        "car_make": u.get("car_make", ""),
        "car_model": u.get("car_model", ""),
        "car_color": u.get("car_color", ""),
        # Device identity so the owner can see what each tester is running.
        "push_platform": u.get("push_platform", ""),
        "device_model": u.get("device_model", ""),
        "device_brand": u.get("device_brand", ""),
        "os_name": u.get("os_name", ""),
        "os_version": u.get("os_version", ""),
        "created_at": u.get("created_at"),
        "last_seen": u.get("last_seen"),
    } for u in users]

@api.post("/admin/reset-code")
async def admin_reset_code(body: ForgotPasswordIn, user=Depends(get_current_user)):
    if not _is_owner(user):
        raise HTTPException(status_code=403, detail="Owner only")
    email = body.email.strip().lower()
    target = await db.users.find_one({"email": email})
    if not target:
        raise HTTPException(status_code=404, detail="No account with that email")
    code = f"{_secrets.randbelow(1000000):06d}"
    expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
    await db.users.update_one({"id": target["id"]}, {"$set": {
        "reset_code": code, "reset_code_expires": expires,
    }})
    # The owner relays this code to the tester, who enters it on the existing
    # reset screen along with a new password. 30-min window for the hand-off.
    return {"email": email, "handle": target.get("handle", ""), "code": code, "expires_at": expires}


# ---------- Permanent Android install link ----------
# ONE stable URL to hand testers: /api/install/android. It 302-redirects to
# whatever build the owner has marked current, so the QR / link you share never
# changes across builds - you just repoint the target from the Admin panel after
# each new build. The target persists in Mongo so it survives redeploys.
_DEFAULT_ANDROID_INSTALL = "https://expo.dev/accounts/sw0rdfisch/projects/convoy/builds/dd56c0d1-5b94-4a2d-9a5d-5c228487dc56"  # 1.1.7 (32)

class InstallUrlIn(BaseModel):
    url: str

async def _android_install_url() -> str:
    doc = await db.config.find_one({"_id": "android_install"})
    return (doc or {}).get("url") or _DEFAULT_ANDROID_INSTALL

@api.get("/install/android")
async def install_android():
    return RedirectResponse(await _android_install_url(), status_code=302)

@api.get("/admin/install-url")
async def admin_get_install_url(user=Depends(get_current_user)):
    if not _is_owner(user):
        raise HTTPException(status_code=403, detail="Owner only")
    return {"url": await _android_install_url()}

@api.post("/admin/install-url")
async def admin_set_install_url(body: InstallUrlIn, user=Depends(get_current_user)):
    if not _is_owner(user):
        raise HTTPException(status_code=403, detail="Owner only")
    url = body.url.strip()
    if not url.startswith("http"):
        raise HTTPException(status_code=400, detail="Enter a full https:// build URL")
    await db.config.update_one({"_id": "android_install"}, {"$set": {"url": url}}, upsert=True)
    return {"ok": True, "url": url}


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
    # token is optional now: a user who denied push still calls this so we can
    # record which device they're on for the admin roster (device_* fields).
    token: Optional[str] = None
    platform: str  # "android" | "ios" | "web"
    # Human-readable device identity (expo-device on the client). All optional —
    # older clients and the web preview won't send them.
    device_model: Optional[str] = None    # "iPhone 15 Pro", "Pixel 7"
    device_brand: Optional[str] = None    # "Apple", "Google", "Samsung"
    os_name: Optional[str] = None         # "iOS", "Android"
    os_version: Optional[str] = None      # "18.1", "14"


@api.put("/auth/push-token")
async def save_push_token(body: PushTokenBody, user=Depends(get_current_user)):
    """Persist the device push token + platform + device identity.

    Idempotent — the client may call this on every cold start since tokens can
    rotate. Token is optional (a user who denied push still reports their
    device for the admin roster); device_* fields are stored when present.
    """
    if body.platform not in ("ios", "android", "web"):
        # `web` will never deliver via push but we accept it so the call
        # doesn't 4xx on devs running in the browser preview.
        raise HTTPException(status_code=400, detail="Invalid platform")
    update: dict = {"push_platform": body.platform}
    if body.token and body.token.strip():
        update["push_token"] = body.token
    for field in ("device_model", "device_brand", "os_name", "os_version"):
        val = getattr(body, field)
        if val:
            update[field] = val
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    return {"ok": True}


# ---------- Location ----------
@api.post("/location")
async def update_location(body: LocationIn, user=Depends(get_current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {
        "lat": body.lat, "lng": body.lng, "speed": body.speed, "heading": body.heading,
        "last_seen": datetime.now(timezone.utc).isoformat(),
    }})
    await ws_manager.broadcast({"type": "location", "user_id": user["id"], "handle": user.get("handle", ""),
                                "lat": body.lat, "lng": body.lng, "speed": body.speed, "heading": body.heading,
                                "car_make": user.get("car_make", ""), "car_model": user.get("car_model", ""),
                                "car_color": user.get("car_color", ""), "car_type": user.get("car_type", "sedan")})
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
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    if not h:
        raise HTTPException(status_code=404, detail="Not found")
    # Count DISTINCT confirming drivers only (a driver can't pad the count).
    # A "still there" vote also refreshes the 30-min expiry window, since the
    # hazard was just observed to still be present.
    if user["id"] not in h.get("confirmed_by", []):
        await db.hazards.update_one({"id": hid}, {
            "$inc": {"confirms": 1},
            "$addToSet": {"confirmed_by": user["id"]},
            "$set": {"expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()},
        })
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    await ws_manager.broadcast({"type": "hazard_update", "hazard": h})
    return h


@api.post("/hazards/{hid}/dispute")
async def dispute_hazard(hid: str, user=Depends(get_current_user)):
    """Community downvote — increments dispute counter so other clients can hide
    heavily-disputed hazards. Kept for back-compat with older clients; new
    clients call DELETE /hazards/{hid} directly to remove the marker."""
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    if not h:
        raise HTTPException(status_code=404, detail="Not found")
    # Count DISTINCT disputing drivers. One driver tapping "Gone" twice can't
    # erase a real hazard - it takes a SECOND independent driver. Once two
    # different drivers agree it's gone, remove the pin for everyone and fan
    # the removal out over the socket so every map clears within ~1s.
    disputed_by = h.get("disputed_by", [])
    if user["id"] not in disputed_by:
        disputed_by = disputed_by + [user["id"]]
        await db.hazards.update_one({"id": hid}, {
            "$inc": {"disputes": 1},
            "$addToSet": {"disputed_by": user["id"]},
        })
    if len(disputed_by) >= 2:
        await db.hazards.delete_one({"id": hid})
        asyncio.create_task(supa.delete_row("hazards", hid))
        await ws_manager.broadcast({"type": "hazard_removed", "id": hid})
        return {"ok": True, "id": hid, "removed": True}
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    await ws_manager.broadcast({"type": "hazard_update", "hazard": h})
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
    # 3. Fan the removal out over our own socket too, so clients that aren't on
    #    Supabase Realtime (or whose Realtime dropped) still clear the pin fast.
    await ws_manager.broadcast({"type": "hazard_removed", "id": hid})
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
        viewer_is_admin = _is_comm_admin(c, user["id"])
        out["members_users"] = [
            {
                "id": u["id"],
                "handle": u.get("handle", ""),
                "car_make": u.get("car_make", ""),
                "car_model": u.get("car_model", ""),
                "car_color": u.get("car_color", ""),
                "car_type": u.get("car_type", ""),
                # Email only visible to admins (privacy-friendly default).
                "email": u.get("email", "") if viewer_is_admin or u["id"] == user["id"] else None,
                # Role flags so the admin UI can show Owner / Admin / Member.
                "is_owner": u["id"] == c.get("admin_id"),
                "is_admin": _is_comm_admin(c, u["id"]),
            }
            for u in members
        ]
    else:
        out["members_users"] = []
    if _is_comm_admin(c, user["id"]):
        # Pending join-request details — visible to any admin (owner or co-admin).
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
    if not _is_comm_admin(c, user["id"]): raise HTTPException(status_code=403, detail="Admin only")
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
    if not _is_comm_admin(c, user["id"]): raise HTTPException(status_code=403, detail="Admin only")
    await db.communities.update_one({"id": cid}, {"$pull": {"pending_requests": uid}})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

# ---------- Community admin: member + admin management ----------
# Global user search so a community admin can find ANYONE on Convoy by handle or
# email and add them. Min 2 chars; escaped so user input can't inject regex.
@api.get("/users/search")
async def search_users_global(q: str, user=Depends(get_current_user)):
    term = (q or "").strip()
    if len(term) < 2:
        return []
    rx = {"$regex": re.escape(term), "$options": "i"}
    found = await db.users.find(
        {"$or": [{"handle": rx}, {"email": rx}]},
        {"_id": 0, "password_hash": 0},
    ).limit(20).to_list(20)
    return [{
        "id": u["id"], "handle": u.get("handle", ""),
        "car_make": u.get("car_make", ""), "car_model": u.get("car_model", ""),
        "car_color": u.get("car_color", ""),
    } for u in found]

# Admin directly adds a found user to the community (no pending step).
@api.post("/communities/{cid}/members/{uid}")
async def admin_add_member(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if not _is_comm_admin(c, user["id"]): raise HTTPException(status_code=403, detail="Admin only")
    if not await db.users.find_one({"id": uid}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=404, detail="User not found")
    await db.communities.update_one({"id": cid}, {
        "$addToSet": {"members": uid}, "$pull": {"pending_requests": uid},
    })
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

# Admin removes a member. The owner can't be removed; only the owner can remove
# another admin (co-admins can't kick each other or the owner).
@api.delete("/communities/{cid}/members/{uid}")
async def admin_remove_member(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if not _is_comm_admin(c, user["id"]): raise HTTPException(status_code=403, detail="Admin only")
    if uid == c.get("admin_id"): raise HTTPException(status_code=400, detail="Can't remove the owner")
    if uid in c.get("co_admins", []) and user["id"] != c.get("admin_id"):
        raise HTTPException(status_code=403, detail="Only the owner can remove an admin")
    await db.communities.update_one({"id": cid}, {"$pull": {"members": uid, "co_admins": uid, "pending_requests": uid}})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

# Owner promotes a member to co-admin (max 2).
@api.post("/communities/{cid}/admins/{uid}")
async def add_co_admin(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"): raise HTTPException(status_code=403, detail="Owner only")
    if uid not in c.get("members", []): raise HTTPException(status_code=400, detail="Must be a member first")
    if uid == c.get("admin_id"): raise HTTPException(status_code=400, detail="Already the owner")
    co = c.get("co_admins", [])
    if uid not in co:
        if len(co) >= 2: raise HTTPException(status_code=400, detail="Max 2 co-admins")
        await db.communities.update_one({"id": cid}, {"$addToSet": {"co_admins": uid}})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

# Owner demotes a co-admin back to a regular member.
@api.delete("/communities/{cid}/admins/{uid}")
async def remove_co_admin(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"): raise HTTPException(status_code=403, detail="Owner only")
    await db.communities.update_one({"id": cid}, {"$pull": {"co_admins": uid}})
    fresh = await db.communities.find_one({"id": cid}, {"_id": 0})
    return public_community(fresh, viewer_id=user["id"])

# Owner hands the community over to another member. The new owner is removed from
# co_admins (now the owner); the old owner stays on as a regular member.
@api.post("/communities/{cid}/transfer/{uid}")
async def transfer_ownership(cid: str, uid: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": cid})
    if not c: raise HTTPException(status_code=404, detail="Not found")
    if user["id"] != c.get("admin_id"): raise HTTPException(status_code=403, detail="Owner only")
    if uid not in c.get("members", []): raise HTTPException(status_code=400, detail="New owner must be a member")
    new_owner = await db.users.find_one({"id": uid}, {"_id": 0, "handle": 1})
    await db.communities.update_one({"id": cid}, {
        "$set": {"admin_id": uid, "admin_handle": (new_owner or {}).get("handle", "")},
        "$pull": {"co_admins": uid},
        "$addToSet": {"members": uid},
    })
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

PTT_GAIN_DB = 16.0          # ~+16 dB (≈ ×6.3 amplitude) — ~25% louder than the
                            # previous +14 dB/×5, per field feedback. The
                            # compressor below tames the extra peaks.
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
    _now = datetime.now(timezone.utc)
    msg = {
        "id": str(uuid.uuid4()), "channel": body.channel, "user_id": user["id"],
        "handle": user.get("handle", ""), "audio_b64": boosted_b64,
        "duration_ms": body.duration_ms, "created_at": _now.isoformat(),
        # Transmissions auto-expire after 5 hours. `expires_at` is both the
        # filter used by GET /ptt and the field a MongoDB TTL index watches to
        # PERMANENTLY delete the clip (see startup index). So old comms can
        # never resurface on a fresh install / new build.
        "expires_at": (_now + timedelta(hours=5)).isoformat(),
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
    # offline members + no-ops when there's nothing to deliver. Fire-and-forget
    # so it never blocks the HTTP response or the live WS delivery above.
    asyncio.create_task(_send_ptt_push(members, user.get("handle", ""), body.channel, user["id"]))
    return {"ok": True, "id": msg["id"]}

@api.get("/ptt/{channel}")
async def list_ptt(channel: str, user=Depends(get_current_user)):
    c = await db.communities.find_one({"id": channel})
    if not c or user["id"] not in c.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    # Hard 5-hour window — never return (and lazily purge) anything older, so a
    # stale clip can't resurface after a reinstall even before the TTL index
    # sweeps it. The TTL index (see startup) is the permanent deleter; this
    # filter is the immediate guarantee at read time.
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
    # Fire-and-forget purge of this channel's expired clips.
    asyncio.create_task(db.ptt.delete_many({"channel": channel, "created_at": {"$lt": cutoff}}))
    cursor = db.ptt.find(
        {"channel": channel, "created_at": {"$gte": cutoff}}, {"_id": 0}
    ).sort("created_at", -1).limit(20)
    items = await cursor.to_list(20)
    return list(reversed(items))


@api.delete("/ptt/{ptt_id}")
async def delete_ptt(ptt_id: str, user=Depends(get_current_user)):
    """Delete a single transmission. The author can always delete their own;
    the community admin can delete any clip in their channel (moderation).
    Idempotent: a missing clip returns ok so the client UI stays clean."""
    msg = await db.ptt.find_one({"id": ptt_id}, {"_id": 0})
    if not msg:
        return {"ok": True, "id": ptt_id}
    allowed = msg.get("user_id") == user["id"]
    if not allowed:
        c = await db.communities.find_one({"id": msg.get("channel")}, {"_id": 0})
        allowed = bool(c and c.get("admin_id") == user["id"])
    if not allowed:
        raise HTTPException(status_code=403, detail="You can only delete your own transmissions")
    await db.ptt.delete_one({"id": ptt_id})
    # Real-time removal on other members' Comms lists.
    ch = msg.get("channel")
    if ch:
        c = await db.communities.find_one({"id": ch}, {"_id": 0})
        if c:
            await ws_manager.broadcast_to_users(
                c.get("members", []),
                {"type": "ptt_deleted", "id": ptt_id, "channel": ch},
            )
    return {"ok": True, "id": ptt_id}


# ---------- Voice transcribe ----------
async def _transcribe_audio(file_path: str) -> str:
    """Run Whisper on a local audio file via the OpenAI API.
    Requires OPENAI_API_KEY in the deployment env."""
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not openai_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured")
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


# ---- Gemini voice parsing (multimodal: audio -> {text, intent, query}) ----
# A single Gemini call transcribes the clip AND classifies the intent, replacing
# the Whisper + regex two-step. Gated entirely on GEMINI_API_KEY: if it's unset
# (or the call fails for any reason) /voice/transcribe falls back to Whisper +
# _classify_intent, so the search-bar mic never regresses. The key lives only in
# the Render env (never in the app). Free key: https://aistudio.google.com/apikey
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_VOICE_PROMPT = (
    "You are the voice-command parser for Convoy, a driving app. The audio is a "
    "short clip of a driver speaking, often over road noise.\n"
    "1) Transcribe exactly what they said into `text`.\n"
    "2) Choose exactly one `intent` from: navigate_to, clear_route, report_police, "
    "report_accident, report_road, report_traffic, open_talk, open_music, "
    "open_drive, open_hub, open_map, none.\n"
    "3) If intent is navigate_to, set `query` to JUST the destination, cleaned up "
    "for a maps search (e.g. \"head over to the Timmies on McCallum\" -> "
    "\"Tim Hortons McCallum Road\"). Otherwise set query to null.\n"
    "Reply with ONLY a JSON object: "
    "{\"text\": string, \"intent\": string, \"query\": string or null}."
)
_VALID_INTENTS = {
    "navigate_to", "clear_route", "report_police", "report_accident", "report_road",
    "report_traffic", "open_talk", "open_music", "open_drive", "open_hub", "open_map", "none",
}

def _gemini_audio_mime(mime: str) -> str:
    m = (mime or "").lower()
    if "m4a" in m or "mp4" in m or "aac" in m: return "audio/mp4"
    if "wav" in m: return "audio/wav"
    if "mp3" in m or "mpeg" in m: return "audio/mpeg"
    if "ogg" in m: return "audio/ogg"
    return mime or "audio/mp4"

async def _gemini_voice_parse(audio_b64: str, mime: str) -> Optional[dict]:
    """Transcribe + classify in one Gemini call. Returns {text,intent,query?}
    or None to signal 'fall back to Whisper'."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    payload = {
        "contents": [{
            "parts": [
                {"text": GEMINI_VOICE_PROMPT},
                {"inline_data": {"mime_type": _gemini_audio_mime(mime), "data": audio_b64}},
            ],
        }],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.post(url, headers={"x-goog-api-key": key, "Content-Type": "application/json"}, json=payload)
        if r.status_code >= 400:
            logger.warning("Gemini voice error %s: %s", r.status_code, r.text[:240])
            return None
        data = r.json()
        parts = (((data.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or []
        raw = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
        if not raw:
            return None
        import json as _json
        parsed = _json.loads(raw)
        intent = parsed.get("intent")
        if intent not in _VALID_INTENTS or intent == "none":
            intent = None
        out = {"text": parsed.get("text") or "", "intent": intent}
        q = parsed.get("query")
        if intent == "navigate_to" and q:
            out["query"] = str(q).strip()
        return out
    except Exception as e:
        logger.warning("Gemini voice parse failed: %s", str(e)[:200])
        return None


@api.post("/voice/transcribe")
async def transcribe(body: TranscribeIn, user=Depends(get_current_user)):
    import base64
    try: audio_bytes = base64.b64decode(body.audio_b64)
    except Exception: raise HTTPException(status_code=400, detail="Invalid audio")
    if len(audio_bytes) < 1000:
        raise HTTPException(status_code=400, detail="Audio too short")

    # Primary: Gemini multimodal (transcribe + intent in one call). Returns None
    # when GEMINI_API_KEY is unset or the call fails, in which case we fall
    # through to the Whisper + regex path below so the mic never regresses.
    gem = await _gemini_voice_parse(body.audio_b64, body.mime or "audio/m4a")
    if gem is not None:
        return gem

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


# ---- Gemini TTS (controllable natural voice; replaces Nova when configured) ----
# Activated by setting GEMINI_TTS_VOICE in Render (e.g. "Charon"). When unset,
# /tts uses OpenAI Nova exactly as before, so deploying this is inert until you
# flip the switch. On ANY Gemini failure (429 quota, 500, empty audio), /tts
# falls back to the OpenAI path below, so the nav voice never goes silent during
# the swap. Gemini TTS returns raw PCM (24 kHz mono 16-bit); we wrap it in a WAV
# header with the stdlib `wave` module (no ffmpeg) so expo-av can play it.
# Voice options (30): Charon=informative, Iapetus/Erinome=clear, Kore=firm,
# Schedar=even, Vindemiatrix=gentle, Sulafat=warm, etc. Steer tone/pace with
# GEMINI_TTS_STYLE (a natural-language preamble prepended to each line).
GEMINI_TTS_MODEL = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
GEMINI_TTS_VOICE = os.environ.get("GEMINI_TTS_VOICE", "").strip()  # unset = use Nova
GEMINI_TTS_STYLE = os.environ.get(
    "GEMINI_TTS_STYLE",
    "Say in a calm, clear, natural voice at a measured pace, like a car GPS navigator: ",
)

def _pcm_to_wav_b64(pcm_b64: str, rate: int = 24000, channels: int = 1, sampwidth: int = 2) -> str:
    """Wrap raw little-endian PCM (Gemini's audio output) in a WAV container."""
    import io, wave
    pcm = base64.b64decode(pcm_b64)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(rate)
        wf.writeframes(pcm)
    return base64.b64encode(buf.getvalue()).decode("ascii")

async def _gemini_tts(text: str) -> Optional[str]:
    """Generate speech via Gemini TTS. Returns base64 WAV, or None to fall back
    to OpenAI. Gated on GEMINI_API_KEY + GEMINI_TTS_VOICE."""
    import re
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not (key and GEMINI_TTS_VOICE):
        return None
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_TTS_MODEL}:generateContent"
    payload = {
        "contents": [{"parts": [{"text": GEMINI_TTS_STYLE + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_TTS_VOICE}}
            },
        },
    }
    # The TTS preview model occasionally 500s (emits text instead of audio); one
    # quick retry smooths that over per Google's guidance. A 429 is a hard quota
    # signal, so don't retry — fall back to Nova immediately.
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=20.0) as c:
                r = await c.post(url, headers={"x-goog-api-key": key, "Content-Type": "application/json"}, json=payload)
            if r.status_code >= 400:
                logger.warning("Gemini TTS error %s: %s", r.status_code, r.text[:240])
                if r.status_code == 429:
                    return None
                continue
            data = r.json()
            parts = (((data.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or []
            for p in parts:
                if not isinstance(p, dict):
                    continue
                inline = p.get("inlineData") or p.get("inline_data")
                if inline and inline.get("data"):
                    mt = inline.get("mimeType") or inline.get("mime_type") or ""
                    rm = re.search(r"rate=(\d+)", mt)
                    rate = int(rm.group(1)) if rm else 24000
                    return _pcm_to_wav_b64(inline["data"], rate=rate)
            logger.warning("Gemini TTS returned no audio (attempt %d)", attempt + 1)
        except Exception as e:
            logger.warning("Gemini TTS exception: %s", str(e)[:200])
    return None


@api.post("/tts")
async def text_to_speech(body: TTSBody, user=Depends(get_current_user)):
    """Convert short navigation text into a natural-voice MP3 (base64)."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")

    # Primary: Gemini TTS when GEMINI_TTS_VOICE is set (returns base64 WAV).
    # None = not configured or failed -> fall through to OpenAI Nova below.
    gem = await _gemini_tts(text)
    if gem is not None:
        return {"audio_b64": gem, "mime": "audio/wav"}

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
#   2. Sends a WebSocket frame for foregrounded clients, then an Expo push
#      (FCM/APNs via Expo's hosted service) for backgrounded / closed apps. The
#      WS path is always-on, so a missing or invalid token never loses the hail.
# Body shape kept thin so the frontend doesn't need to know which community
# context the modal opened in — `community_id` is optional (used only for
# data payload routing, not the share-check).
class HailBody(BaseModel):
    target_user_id: str
    community_id: Optional[str] = None


# Expo push - Expo's hosted service relays our messages to FCM (Android) and
# APNs (iOS), so the backend never touches either directly. Tokens are the
# "ExponentPushToken[...]" values the app registers on launch. An optional
# EXPO_ACCESS_TOKEN (Expo dashboard -> project -> Access Tokens) adds an auth
# layer but is NOT required for delivery.
EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


async def _send_expo_push(messages: list):
    """Best-effort batch push via Expo. `messages` is a list of
    {to, title, body, data, sound} dicts whose `to` is an Expo push token.
    Never raises - push must never block or break the calling request."""
    if not messages:
        return
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    access = os.environ.get("EXPO_ACCESS_TOKEN", "").strip()
    if access:
        headers["Authorization"] = f"Bearer {access}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Expo accepts up to 100 messages per request.
            for i in range(0, len(messages), 100):
                await client.post(EXPO_PUSH_URL, headers=headers, json=messages[i:i + 100])
    except Exception as e:
        logger.warning(f"Expo push error: {str(e)[:160]}")


async def _send_ptt_push(member_ids, sender_handle: str, channel: str, sender_id: str):
    """Best-effort push fan-out for a PTT transmission.

    Mirrors the Hail push path (Expo). Targets ONLY members who are
    NOT currently connected over the WebSocket — i.e. the app is backgrounded
    or force-closed, which is exactly when the live WS/poll delivery can't
    reach them. Foregrounded members already heard the clip via
    broadcast_to_users, so pushing them too would double-notify.

    Fire-and-forget: never raises, never blocks the /ptt HTTP response. The
    `data.type == "ptt"` payload is what the app's notification handler keys
    on to deep-link into the Comms transcript when tapped.
    """
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
    messages = [{
        "to": t["push_token"],
        "title": "🎙 Convoy comms",
        "body": f"{sender_handle} sent a transmission",
        "data": {"type": "ptt", "channel": channel, "from_handle": sender_handle, "from_id": sender_id},
        "sound": "default",
    } for t in targets]
    await _send_expo_push(messages)


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

    sender_handle = user.get("handle", "A driver")

    # 3. Always fire the WebSocket frame first - foregrounded clients show the
    #    in-app toast even without OS push permission.
    await ws_manager.broadcast_to_users([body.target_user_id], {
        "type": "hail",
        "from_handle": sender_handle,
        "from_id": user["id"],
    })

    # 4. Expo push for backgrounded / closed apps. Best-effort; the WS above is
    #    the always-on path, so a missing or invalid token never loses the hail.
    push_token = target.get("push_token")
    if push_token:
        await _send_expo_push([{
            "to": push_token,
            "title": f"👊 YOHB from {sender_handle}",
            "body": f"{sender_handle} sent you a YOHB on Convoy",
            "data": {
                "type": "hail",
                "from_id": user["id"],
                "from_handle": sender_handle,
                "community_id": body.community_id or "",
            },
            "sound": "default",
            "badge": 1,
        }])
        return {"ok": True, "method": "expo+ws"}
    return {"ok": True, "method": "ws"}


# ---------- Share to specific members (peer push, any content kind) ----------
# Generalizes the Hail path: lets a user push a piece of content — a song, a
# route, or a comms clip — to one or more SPECIFIC members they share a
# community with. Delivered the same way as a hail: a WS frame for foregrounded
# clients plus an Expo push for backgrounded/closed apps, with a
# `data.type == "share"` payload the app keys on to show/open the shared item.
class ShareBody(BaseModel):
    target_user_ids: List[str]
    kind: str                        # "music" | "route" | "comm"
    payload: Optional[dict] = None   # kind-specific (e.g. {title, artist, url})
    community_id: Optional[str] = None

_SHARE_KINDS = {"music", "route", "comm"}

@api.post("/notifications/share")
async def share_to_members(body: ShareBody, user=Depends(get_current_user)):
    if body.kind not in _SHARE_KINDS:
        raise HTTPException(status_code=400, detail="Invalid share kind")
    targets_in = [t for t in (body.target_user_ids or []) if t and t != user["id"]]
    if not targets_in:
        raise HTTPException(status_code=400, detail="No recipients")

    # Only allow sharing to people the sender shares at least one community with
    # (same anti-spam guard as Hail). Collect the union of co-members.
    allowed: set = set()
    async for c in db.communities.find({"members": user["id"]}, {"_id": 0, "members": 1}):
        allowed.update(c.get("members", []))
    allowed.discard(user["id"])
    recipients = [t for t in targets_in if t in allowed]
    if not recipients:
        raise HTTPException(status_code=403, detail="You can only share with members of your communities")

    sender_handle = user.get("handle", "A driver")
    payload = body.payload or {}

    if body.kind == "music":
        title = f"\U0001F3B5 {sender_handle} shared a song"
        sub = " — ".join([p for p in [payload.get("title"), payload.get("artist")] if p]) or "Tap to listen"
    elif body.kind == "route":
        title = f"\U0001F4CD {sender_handle} shared a route"
        sub = payload.get("name") or payload.get("dest_label") or "Tap to navigate"
    else:  # comm
        title = f"\U0001F399 {sender_handle} shared a clip"
        sub = "Tap to listen in Comms"

    data = {
        "type": "share",
        "kind": body.kind,
        "from_id": user["id"],
        "from_handle": sender_handle,
        "community_id": body.community_id or "",
        "payload": payload,
    }

    # 1. WS frame — foregrounded clients can show an in-app toast.
    await ws_manager.broadcast_to_users(recipients, {
        "type": "share",
        "kind": body.kind,
        "from_handle": sender_handle,
        "from_id": user["id"],
        "payload": payload,
    })

    # 2. Expo push for backgrounded / closed apps.
    tokens = await db.users.find(
        {"id": {"$in": recipients}, "push_token": {"$nin": [None, ""]}},
        {"_id": 0, "id": 1, "push_token": 1},
    ).to_list(500)
    messages = [{
        "to": t["push_token"],
        "title": title,
        "body": sub,
        "data": data,
        "sound": "default",
    } for t in tokens]
    await _send_expo_push(messages)

    return {"ok": True, "delivered": len(recipients)}


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
    # A single user can hold MORE THAN ONE socket at once - the Map screen opens
    # one for live peer locations while the app-wide PTT listener (livePtt.ts)
    # holds another for comms. The old design kept ONE socket per user and closed
    # the previous one on every new connect, so those two sockets fought and kept
    # kicking each other off - which dropped live comms whenever the Map tab was
    # open. We now keep a SET of sockets per user and fan out to all of them, so
    # comms come through seamlessly on every tab.
    def __init__(self):
        self.active: Dict[str, set] = {}
        self.lock = asyncio.Lock()

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        async with self.lock:
            self.active.setdefault(user_id, set()).add(ws)

    async def disconnect(self, user_id: str, ws: Optional[WebSocket] = None):
        async with self.lock:
            if ws is None:
                self.active.pop(user_id, None)
            else:
                conns = self.active.get(user_id)
                if conns is not None:
                    conns.discard(ws)
                    if not conns:
                        self.active.pop(user_id, None)

    async def _send(self, ws, message: dict) -> bool:
        try:
            await ws.send_json(message)
            return True
        except Exception:
            return False

    async def broadcast(self, message: dict):
        dead = []  # (user_id, ws) pairs whose send failed
        for uid, conns in list(self.active.items()):
            for ws in list(conns):
                if not await self._send(ws, message):
                    dead.append((uid, ws))
        for uid, ws in dead:
            await self.disconnect(uid, ws)

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
        for uid in target:
            conns = self.active.get(uid)
            if not conns:
                continue
            for ws in list(conns):
                if not await self._send(ws, message):
                    dead.append((uid, ws))
        for uid, ws in dead:
            await self.disconnect(uid, ws)

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
        await ws_manager.disconnect(user_id, websocket)
    except Exception as e:
        logger.warning(f"WS error: {e}")
        await ws_manager.disconnect(user_id, websocket)


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
    await db.ptt.create_index("created_at")
    await db.communities.create_index("id", unique=True)
    await db.communities.create_index("invite_code")
    await db.communities.create_index("name")

    # Background sweeper: permanently delete PTT transmissions older than 5h.
    # created_at is stored as an ISO string (not a BSON Date), so a native TTL
    # index won't apply — we run our own lightweight purge every 30 min. This
    # guarantees clips are gone server-wide even for channels no one opens.
    async def _ptt_sweeper():
        while True:
            try:
                cutoff = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
                await db.ptt.delete_many({"created_at": {"$lt": cutoff}})
            except Exception as e:
                logger.warning("PTT sweeper error: %s", str(e)[:160])
            await asyncio.sleep(1800)  # 30 minutes
    asyncio.create_task(_ptt_sweeper())

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
