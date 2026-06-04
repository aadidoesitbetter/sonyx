# ============================================================
#  config.py  —  Bot credentials & settings
#  Set DISCORD_TOKEN as an environment variable (Railway dashboard or .env locally)
# ============================================================

import os
from dotenv import load_dotenv

load_dotenv()  # loads .env when running locally; no-op in production

# ── Discord ──────────────────────────────────────────────────
DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN")


# ── Command prefix (users can also use /ytaudio slash command)
# Examples: "!", "?", ">>", "$", "."
PREFIX = ","

# ── Audio settings ───────────────────────────────────────────
# Output format: "mp3" | "m4a" | "opus" | "wav" | "flac"
AUDIO_FORMAT = "mp3"

# Audio quality (for mp3/m4a):
#   "0" = best (largest file)  |  "9" = worst (smallest file)
AUDIO_QUALITY = "0"

# Max video duration in seconds (0 = no limit)
# 600 = 10 min, 3600 = 1 hour
MAX_DURATION = 600

# ── File cleanup ─────────────────────────────────────────────
# Delete the local audio file after sending it to Discord
DELETE_AFTER_SEND = True

# ── Optional: restrict bot to specific channel IDs ───────────
# Leave empty [] to allow the bot in ALL channels
ALLOWED_CHANNELS = []   # e.g. [123456789012345678, 987654321098765432]
