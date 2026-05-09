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
import hashlib
import time
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

class LoginIn(BaseModel):
    email: EmailStr
    password: str

class CarUpdate(BaseModel):
    handle: Optional[str] = None
    car_make: Optional[str] = None
    car_model: Optional[str] = None
    car_year: Optional[int] = None
    car_color: Optional[str] = None

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

class CommunityUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_public: Optional[bool] = None


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
        "lat": u.get("lat"), "lng": u.get("lng"),
        "heading": u.get("heading", 0), "speed": u.get("speed", 0),
    }

def public_community(c: dict, viewer_id: Optional[str] = None) -> dict:
    members = c.get("members", [])
    pending = c.get("pending_requests", [])
    return {
        "id": c["id"], "name": c["name"], "description": c.get("description", ""),
        "is_public": c.get("is_public", True),
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


# ---------- Communities ----------
@api.post("/communities")
async def create_community(body: CommunityIn, user=Depends(get_current_user)):
    cid = str(uuid.uuid4())
    code = _secrets.token_urlsafe(6)
    doc = {
        "id": cid, "name": body.name, "description": body.description or "",
        "is_public": body.is_public, "admin_id": user["id"], "admin_handle": user.get("handle", ""),
        "members": [user["id"]], "pending_requests": [], "invite_code": code,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.communities.insert_one(doc)
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
    out = public_community(c, viewer_id=user["id"])
    if user["id"] == c.get("admin_id"):
        # Return pending request user details for admin
        pending = c.get("pending_requests", [])
        users = await db.users.find({"id": {"$in": pending}}, {"_id": 0, "password_hash": 0}).to_list(200) if pending else []
        out["pending_users"] = [{"id": u["id"], "handle": u.get("handle", ""), "email": u.get("email", "")} for u in users]
    return out

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
    return {"ok": True}


# ---------- PTT (channel = community id) ----------
@api.post("/ptt")
async def post_ptt(body: PTTIn, user=Depends(get_current_user)):
    # Verify membership
    c = await db.communities.find_one({"id": body.channel})
    if not c or user["id"] not in c.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member of this community")
    msg = {
        "id": str(uuid.uuid4()), "channel": body.channel, "user_id": user["id"],
        "handle": user.get("handle", ""), "audio_b64": body.audio_b64,
        "duration_ms": body.duration_ms, "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.ptt.insert_one(msg)
    msg.pop("_id", None)
    await ws_manager.broadcast({"type": "ptt", "message": {**msg, "audio_b64": ""}})
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
        from emergentintegrations.llm.openai import OpenAISpeechToText
        stt = OpenAISpeechToText(api_key=os.environ["EMERGENT_LLM_KEY"])
        with open(tmp.name, "rb") as f:
            resp = await stt.transcribe(file=f, model="whisper-1", response_format="json", language="en")
        text = getattr(resp, "text", "") or ""
    except Exception as e:
        logger.exception("Whisper failed")
        raise HTTPException(status_code=500, detail=f"Transcribe failed: {e}")
    finally:
        try: os.unlink(tmp.name)
        except Exception: pass

    return _classify_intent(text)


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


# ---------- External Alerts Feed (Waze-style proxy) ----------
# Polls a JSON feed and normalizes to {id, type, lat, lng, ts, raw_type, subtype}.
# The proxy URL is configurable via env: EXTERNAL_FEED_URL (default below).
# Includes a tiny in-memory cache so 60s frontend polls don't hammer upstream.

EXTERNAL_FEED_URL = os.environ.get("EXTERNAL_FEED_URL", "https://rtproxy-na.waze.com/")
_feed_cache: Dict[str, dict] = {"data": None, "ts": 0.0}
_FEED_CACHE_TTL = 25.0  # seconds — backend caches a bit shorter than client poll cadence

def _normalize_alert_type(raw: str) -> str:
    if not raw: return "OTHER"
    r = str(raw).upper()
    if "POLICE" in r: return "POLICE"
    if "ACCIDENT" in r or "CRASH" in r: return "ACCIDENT"
    if "JAM" in r or "TRAFFIC" in r: return "JAM"
    if "HAZARD" in r or "OBJECT" in r or "POTHOLE" in r or "ROAD" in r or "DEBRIS" in r: return "HAZARD"
    if "CONSTRUCTION" in r: return "CONSTRUCTION"
    if "WEATHER" in r: return "WEATHER"
    return "OTHER"

def _alert_id(item: dict, lat: float, lng: float, raw_type: str) -> str:
    # Prefer feed-provided stable id (uuid / id), otherwise hash type+rounded coords
    for k in ("uuid", "id", "alertId", "alert_id"):
        v = item.get(k)
        if v: return str(v)
    h = hashlib.sha1(f"{raw_type}|{round(lat, 5)}|{round(lng, 5)}".encode()).hexdigest()
    return h[:16]

def _extract_alerts(payload) -> List[dict]:
    """Accept multiple feed shapes: {alerts:[...]}, [...], {data:{alerts:[...]}}."""
    if payload is None: return []
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = (
            payload.get("alerts")
            or payload.get("data", {}).get("alerts") if isinstance(payload.get("data"), dict) else None
        ) or payload.get("items") or []
    else:
        items = []

    out: List[dict] = []
    for it in items:
        if not isinstance(it, dict): continue
        # Coords: {lat,lng} | {latitude,longitude} | {location:{x,y}} (Waze: y=lat,x=lng)
        lat = it.get("lat") or it.get("latitude")
        lng = it.get("lng") or it.get("lon") or it.get("longitude")
        if lat is None or lng is None:
            loc = it.get("location") or {}
            if isinstance(loc, dict):
                lat = loc.get("y") if "y" in loc else loc.get("lat")
                lng = loc.get("x") if "x" in loc else loc.get("lng")
        try:
            lat = float(lat); lng = float(lng)
        except (TypeError, ValueError):
            continue
        raw_type = str(it.get("type") or it.get("alertType") or "OTHER")
        subtype = it.get("subtype") or it.get("subType") or ""
        ts_val = it.get("pubMillis") or it.get("ts") or it.get("timestamp")
        try:
            ts = float(ts_val) / (1000.0 if ts_val and ts_val > 1e12 else 1.0) if ts_val else time.time()
        except (TypeError, ValueError):
            ts = time.time()
        out.append({
            "id": _alert_id(it, lat, lng, raw_type),
            "type": _normalize_alert_type(raw_type),
            "raw_type": raw_type,
            "subtype": subtype,
            "lat": lat, "lng": lng,
            "ts": ts,
        })
    return out

@api.get("/feed/external")
async def external_feed(
    user=Depends(get_current_user),
    top: Optional[float] = None,
    bottom: Optional[float] = None,
    left: Optional[float] = None,
    right: Optional[float] = None,
):
    """Proxy + normalize an external alerts feed (Waze-style).
    Frontend polls this every ~60s; backend caches 25s to soften upstream load."""
    now = time.time()
    if _feed_cache["data"] is not None and (now - _feed_cache["ts"]) < _FEED_CACHE_TTL:
        return _feed_cache["data"]

    params = {}
    if top is not None: params["top"] = top
    if bottom is not None: params["bottom"] = bottom
    if left is not None: params["left"] = left
    if right is not None: params["right"] = right

    payload = None
    upstream_status = "ok"
    upstream_error: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(EXTERNAL_FEED_URL, params=params or None,
                                    headers={"User-Agent": "Convoy/1.0", "Accept": "application/json"})
            resp.raise_for_status()
            try:
                payload = resp.json()
            except Exception:
                # Some Waze proxies return text/plain JSON without proper content-type
                import json as _json
                payload = _json.loads(resp.text)
    except httpx.HTTPStatusError as e:
        upstream_status = "http_error"
        upstream_error = f"{e.response.status_code}"
    except httpx.RequestError as e:
        upstream_status = "network_error"
        upstream_error = str(e)[:120]
    except Exception as e:
        upstream_status = "parse_error"
        upstream_error = str(e)[:120]

    alerts = _extract_alerts(payload) if payload is not None else []
    out = {
        "alerts": alerts,
        "count": len(alerts),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": EXTERNAL_FEED_URL,
        "upstream_status": upstream_status,
        "upstream_error": upstream_error,
    }
    _feed_cache["data"] = out
    _feed_cache["ts"] = now
    return out


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


app.include_router(api)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.hazards.create_index("expires_at")
    await db.ptt.create_index([("channel", 1), ("created_at", -1)])
    await db.communities.create_index("id", unique=True)
    await db.communities.create_index("invite_code")
    await db.communities.create_index("name")

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
