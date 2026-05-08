from dotenv import load_dotenv
from pathlib import Path
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import uuid
import logging
import asyncio
import tempfile
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict

import jwt
import bcrypt
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, UploadFile, File, WebSocket, WebSocketDisconnect, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr

# Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("rev_radar")

# Mongo
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALG = "HS256"

app = FastAPI(title="Rev Radar API")
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
    kind: str  # police | road | accident | traffic
    lat: float
    lng: float
    note: Optional[str] = ""

class TranscribeIn(BaseModel):
    audio_b64: str
    mime: Optional[str] = "audio/m4a"

class PTTIn(BaseModel):
    channel: str
    audio_b64: str
    duration_ms: int = 0


# ---------- Helpers ----------
def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False

def make_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=7),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "email": u["email"],
        "handle": u.get("handle", ""),
        "car_make": u.get("car_make", ""),
        "car_model": u.get("car_model", ""),
        "car_year": u.get("car_year"),
        "car_color": u.get("car_color", ""),
        "lat": u.get("lat"),
        "lng": u.get("lng"),
        "heading": u.get("heading", 0),
        "speed": u.get("speed", 0),
    }

async def get_current_user(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer)) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ---------- Auth routes ----------
@api.post("/auth/register")
async def register(body: RegisterIn):
    email = body.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": email,
        "password_hash": hash_pw(body.password),
        "handle": body.handle,
        "car_make": body.car_make or "",
        "car_model": body.car_model or "",
        "car_year": body.car_year,
        "car_color": body.car_color or "",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "lat": None, "lng": None, "heading": 0, "speed": 0,
        "last_seen": None,
    }
    await db.users.insert_one(doc)
    token = make_token(user_id, email)
    return {"token": token, "user": public_user(doc)}

@api.post("/auth/login")
async def login(body: LoginIn):
    email = body.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_pw(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = make_token(user["id"], email)
    return {"token": token, "user": public_user(user)}

@api.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return public_user(user)

@api.put("/auth/profile")
async def update_profile(body: CarUpdate, user=Depends(get_current_user)):
    update = {k: v for k, v in body.dict().items() if v is not None}
    if update:
        await db.users.update_one({"id": user["id"]}, {"$set": update})
    fresh = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    return public_user(fresh)


# ---------- Location ----------
@api.post("/location")
async def update_location(body: LocationIn, user=Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {
            "lat": body.lat, "lng": body.lng,
            "speed": body.speed, "heading": body.heading,
            "last_seen": datetime.now(timezone.utc).isoformat(),
        }},
    )
    # Broadcast via websocket pool
    await ws_manager.broadcast({
        "type": "location",
        "user_id": user["id"],
        "handle": user.get("handle", ""),
        "lat": body.lat, "lng": body.lng,
        "speed": body.speed, "heading": body.heading,
    })
    return {"ok": True}

@api.get("/users/nearby")
async def nearby_users(user=Depends(get_current_user)):
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    cursor = db.users.find(
        {"lat": {"$ne": None}, "last_seen": {"$gte": cutoff}, "id": {"$ne": user["id"]}},
        {"_id": 0, "password_hash": 0},
    )
    users = await cursor.to_list(200)
    return [public_user(u) for u in users]


# ---------- Hazards ----------
@api.post("/hazards")
async def create_hazard(body: HazardIn, user=Depends(get_current_user)):
    if body.kind not in ("police", "road", "accident", "traffic"):
        raise HTTPException(status_code=400, detail="Invalid hazard kind")
    h = {
        "id": str(uuid.uuid4()),
        "kind": body.kind,
        "lat": body.lat, "lng": body.lng,
        "note": body.note or "",
        "reporter_id": user["id"],
        "reporter_handle": user.get("handle", ""),
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
    items = await cursor.to_list(500)
    return items

@api.post("/hazards/{hid}/confirm")
async def confirm_hazard(hid: str, user=Depends(get_current_user)):
    res = await db.hazards.update_one({"id": hid}, {"$inc": {"confirms": 1}})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="Not found")
    h = await db.hazards.find_one({"id": hid}, {"_id": 0})
    return h


# ---------- Walkie-talkie channels & PTT ----------
DEFAULT_CHANNELS = [
    {"id": "general", "name": "General", "desc": "All car enthusiasts"},
    {"id": "jdm", "name": "JDM Lounge", "desc": "Japanese imports"},
    {"id": "muscle", "name": "Muscle Garage", "desc": "American muscle cars"},
    {"id": "euro", "name": "Euro Drive", "desc": "European exotics & sport"},
    {"id": "trucks", "name": "Trucks & Off-road", "desc": "4x4 and trucks"},
]

@api.get("/channels")
async def list_channels(user=Depends(get_current_user)):
    return DEFAULT_CHANNELS

@api.post("/ptt")
async def post_ptt(body: PTTIn, user=Depends(get_current_user)):
    msg = {
        "id": str(uuid.uuid4()),
        "channel": body.channel,
        "user_id": user["id"],
        "handle": user.get("handle", ""),
        "audio_b64": body.audio_b64,
        "duration_ms": body.duration_ms,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.ptt.insert_one(msg)
    msg.pop("_id", None)
    # Broadcast metadata; clients fetch audio individually if needed (audio is in payload).
    await ws_manager.broadcast({"type": "ptt", "message": msg})
    return {"ok": True, "id": msg["id"]}

@api.get("/ptt/{channel}")
async def list_ptt(channel: str, user=Depends(get_current_user)):
    cursor = db.ptt.find({"channel": channel}, {"_id": 0}).sort("created_at", -1).limit(20)
    items = await cursor.to_list(20)
    return list(reversed(items))


# ---------- Voice Whisper transcribe ----------
@api.post("/voice/transcribe")
async def transcribe(body: TranscribeIn, user=Depends(get_current_user)):
    import base64
    try:
        audio_bytes = base64.b64decode(body.audio_b64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid audio")
    suffix = ".m4a" if "m4a" in (body.mime or "") else ".wav"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(audio_bytes)
    tmp.flush()
    tmp.close()
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
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    # Parse simple commands
    lt = text.lower()
    intent = None
    if "police" in lt or "cop" in lt:
        intent = "report_police"
    elif "accident" in lt or "crash" in lt:
        intent = "report_accident"
    elif "hazard" in lt or "debris" in lt or "pothole" in lt:
        intent = "report_road"
    elif "traffic" in lt or "jam" in lt:
        intent = "report_traffic"
    elif "talk" in lt or "channel" in lt or "walkie" in lt:
        intent = "open_talk"
    elif "music" in lt or "play" in lt or "song" in lt:
        intent = "open_music"
    elif "drive" in lt or "carplay" in lt:
        intent = "open_drive"
    elif "map" in lt:
        intent = "open_map"

    return {"text": text, "intent": intent}


# ---------- WebSocket manager ----------
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
            try:
                await old.close()
            except Exception:
                pass

    async def disconnect(self, user_id: str):
        async with self.lock:
            self.active.pop(user_id, None)

    async def broadcast(self, message: dict):
        dead = []
        for uid, ws in list(self.active.items()):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(uid)
        for uid in dead:
            await self.disconnect(uid)

ws_manager = WSManager()


@app.websocket("/api/ws")
async def ws_endpoint(websocket: WebSocket, token: Optional[str] = None):
    if not token:
        await websocket.close(code=4401)
        return
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload["sub"]
    except Exception:
        await websocket.close(code=4401)
        return
    await ws_manager.connect(user_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            mtype = data.get("type")
            if mtype == "ping":
                await websocket.send_json({"type": "pong"})
            elif mtype == "location":
                # passthrough broadcast
                await ws_manager.broadcast({
                    "type": "location",
                    "user_id": user_id,
                    "lat": data.get("lat"),
                    "lng": data.get("lng"),
                    "heading": data.get("heading", 0),
                    "speed": data.get("speed", 0),
                })
            elif mtype == "ptt":
                # broadcast audio chunks live
                await ws_manager.broadcast({
                    "type": "ptt_live",
                    "user_id": user_id,
                    "channel": data.get("channel", "general"),
                    "audio_b64": data.get("audio_b64", ""),
                    "duration_ms": data.get("duration_ms", 0),
                    "handle": data.get("handle", ""),
                })
    except WebSocketDisconnect:
        await ws_manager.disconnect(user_id)
    except Exception as e:
        logger.warning(f"WS error: {e}")
        await ws_manager.disconnect(user_id)


@api.get("/")
async def root():
    return {"service": "Rev Radar", "ok": True}


# Mount router
app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.hazards.create_index("expires_at")
    await db.ptt.create_index([("channel", 1), ("created_at", -1)])
    # Seed demo users with locations
    seeds = [
        {"email": "demo@revradar.app", "password": "demo1234", "handle": "DemoDriver", "car": ("Toyota", "Supra", 1998, "Red")},
        {"email": "alex@revradar.app", "password": "demo1234", "handle": "AlexGT", "car": ("BMW", "M3", 2022, "Blue")},
        {"email": "sara@revradar.app", "password": "demo1234", "handle": "SaraS2K", "car": ("Honda", "S2000", 2005, "Yellow")},
    ]
    for s in seeds:
        existing = await db.users.find_one({"email": s["email"]})
        if not existing:
            uid = str(uuid.uuid4())
            await db.users.insert_one({
                "id": uid,
                "email": s["email"],
                "password_hash": hash_pw(s["password"]),
                "handle": s["handle"],
                "car_make": s["car"][0],
                "car_model": s["car"][1],
                "car_year": s["car"][2],
                "car_color": s["car"][3],
                "created_at": datetime.now(timezone.utc).isoformat(),
                "lat": None, "lng": None, "heading": 0, "speed": 0,
                "last_seen": None,
            })
    logger.info("Rev Radar started.")


@app.on_event("shutdown")
async def shutdown():
    client.close()
