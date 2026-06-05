# ============================================================
#  config.py  —  Bot credentials & settings
#  Set secrets as environment variables (Railway dashboard or .env locally)
# ============================================================

import os
from dotenv import load_dotenv

load_dotenv()  # loads .env when running locally; no-op in production

# ── Discord ──────────────────────────────────────────────────
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")

# ── Command prefix ───────────────────────────────────────────
# Examples: "!", "?", ">>", "$", ".", ","
PREFIX = ","

# ── Voice channel inactivity timeout (seconds) ───────────────
# Bot auto-disconnects after this many seconds with no activity
INACTIVITY_TIMEOUT = 180   # 3 minutes

# ── Playlist import cap ──────────────────────────────────────
# Max tracks imported from a playlist URL at once
MAX_PLAYLIST_TRACKS = 10

# ── Optional: restrict bot to specific channel IDs ───────────
# Leave empty [] to allow the bot in ALL channels
ALLOWED_CHANNELS = []   # e.g. [123456789012345678, 987654321098765432]

# ── Legacy: kept for ytaudio_bot.py compatibility ────────────
AUDIO_FORMAT     = "mp3"
AUDIO_QUALITY    = "0"
MAX_DURATION     = 600
DELETE_AFTER_SEND = True

# ── Lavalink (voice player) ───────────────────────────────────
LAVALINK_HOST     = os.getenv("LAVALINK_HOST",     "lavalink.heavencloud.in")
LAVALINK_PORT     = int(os.getenv("LAVALINK_PORT", "443"))
LAVALINK_PASSWORD = os.getenv("LAVALINK_PASSWORD", "heavencloud")
LAVALINK_SECURE   = os.getenv("LAVALINK_SECURE",   "True") == "True"
LAVALINK_ID       = os.getenv("LAVALINK_ID",       "MAIN")

# ── Spotify (for metadata bridging on Spotify links) ─────────
SPOTIFY_CLIENT_ID     = os.getenv("SPOTIFY_CLIENT_ID",     "")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "")

# ── Voice player ──────────────────────────────────────────────
PLAYER_VOLUME    = float(os.getenv("PLAYER_VOLUME",   "1.0"))
DISCONNECT_AFTER = int(os.getenv("DISCONNECT_AFTER",  "300"))  # idle seconds
