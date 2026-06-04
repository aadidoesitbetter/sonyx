"""
sonyx.py — Full-featured Discord music bot.

Platforms: YouTube, SoundCloud, Spotify (via search), Apple Music (via search)
Audio:     yt-dlp + FFmpegOpusAudio (streams directly to VC, no disk writes)
Lyrics:    syncedlyrics (LRCLIB + NetEase, zero API key)

Commands (prefix  + slash):
    play / p         — Play or queue a song (URL or search text)
    pause            — Pause playback
    resume / r       — Resume playback
    skip / s         — Skip current track
    stop             — Stop and disconnect
    queue / q        — Show the queue (paginated)
    nowplaying / np  — Show the currently playing track
    volume / vol     — Set volume (0–100)
    loop             — Cycle loop mode: off → song → queue
    shuffle          — Shuffle the queue
    remove           — Remove a track by position
    clear            — Clear the entire queue
    seek             — Seek to a timestamp (seconds or mm:ss)
    ytinfo           — Preview a video without downloading
    lyrics           — Fetch and display lyrics
    ping             — Latency check
    help             — Show help embed
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import re
import textwrap
import time
import traceback
import urllib.parse
import urllib.request
from collections import deque
from enum import Enum
from pathlib import Path
from typing import Optional

import discord
import yt_dlp
from discord import app_commands
from discord.ext import commands, tasks

# ── Load config ───────────────────────────────────────────────────────────────
try:
    from config import (
        ALLOWED_CHANNELS,
        DISCORD_TOKEN,
        PREFIX,
    )
except ImportError:
    raise SystemExit("❌  config.py not found. Copy config.py next to this file.")

if not DISCORD_TOKEN or DISCORD_TOKEN == "YOUR_DISCORD_BOT_TOKEN_HERE":
    raise SystemExit("❌  DISCORD_TOKEN is not set!")

# ── Ensure ffmpeg/ffprobe are in PATH (bundled via static-ffmpeg pip package) ──
try:
    import static_ffmpeg
    static_ffmpeg.add_paths()   # injects bundled ffmpeg + ffprobe into os.environ["PATH"]
    print("[sonyx] FFmpeg: injected from static-ffmpeg package")
except ImportError:
    print("[sonyx] FFmpeg: static-ffmpeg not installed, using system ffmpeg")
except Exception as e:
    print(f"[sonyx] FFmpeg: static-ffmpeg init failed ({e}), using system ffmpeg")

# ── YouTube cookies from env var (base64-encoded Netscape cookie file) ────────
# To set up: export your YouTube cookies as Netscape format, base64-encode them,
# then add YOUTUBE_COOKIES_B64=<value> in your Railway environment variables.
_yt_cookies_b64 = os.environ.get("YOUTUBE_COOKIES_B64", "").strip()
if _yt_cookies_b64:
    try:
        _cookies_data = base64.b64decode(_yt_cookies_b64).decode("utf-8")
        with open("cookies.txt", "w", encoding="utf-8") as _f:
            _f.write(_cookies_data)
        print("[sonyx] YouTube cookies: loaded from YOUTUBE_COOKIES_B64 env var")
    except Exception as _e:
        print(f"[sonyx] YouTube cookies: failed to decode YOUTUBE_COOKIES_B64 ({_e})")
else:
    print("[sonyx] YouTube cookies: not configured (optional — set YOUTUBE_COOKIES_B64 in Railway env)")


# ── Optional: Spotify support via spotipy ─────────────────────────────────────
try:
    import spotipy
    from spotipy.oauth2 import SpotifyClientCredentials
    _SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
    _SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    if _SPOTIFY_CLIENT_ID and _SPOTIFY_CLIENT_SECRET:
        _sp = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
            client_id=_SPOTIFY_CLIENT_ID,
            client_secret=_SPOTIFY_CLIENT_SECRET,
        ))
        SPOTIFY_ENABLED = True
        print("[sonyx] Spotify support: enabled (spotipy)")
    else:
        _sp = None
        SPOTIFY_ENABLED = False
        print("[sonyx] Spotify support: disabled (set SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET)")
except ImportError:
    _sp = None
    SPOTIFY_ENABLED = False
    print("[sonyx] Spotify support: disabled (install spotipy)")

# ── Optional: syncedlyrics ────────────────────────────────────────────────────
try:
    import syncedlyrics
    LYRICS_ENABLED = True
    print("[sonyx] Lyrics support: enabled (syncedlyrics)")
except ImportError:
    LYRICS_ENABLED = False
    print("[sonyx] Lyrics support: disabled (install syncedlyrics)")

# ── Constants ─────────────────────────────────────────────────────────────────
INACTIVITY_TIMEOUT  = 180        # seconds before auto-disconnect
COOLDOWN_SECONDS    = 30         # per-user cooldown on !play
MAX_PLAYLIST_TRACKS = 10         # cap for playlist imports
SEARCH_RESULTS      = 5          # how many search results to show
QUEUE_PAGE_SIZE     = 10         # tracks per queue page
DISCORD_MAX_BYTES   = 25 * 1024 * 1024

# FFmpeg options for smooth streaming with reconnect support
FFMPEG_OPTS = {
    "before_options": (
        "-reconnect 1 "
        "-reconnect_streamed 1 "
        "-reconnect_delay_max 5 "
        "-loglevel warning"
    ),
    "options": "-vn -af volume=0.5",
}

YDL_BASE = {
    "format": "bestaudio[abr>=128]/bestaudio/best",
    "quiet": True,
    "no_warnings": True,
    "extract_flat": False,
    "skip_download": True,
    "noplaylist": True,
    "cookiefile": "cookies.txt",   # written on startup from YOUTUBE_COOKIES_B64 env var if set
    "source_address": "0.0.0.0",
    "extractor_args": {
        "youtube": {
            "player_client": ["ios", "android", "web"],
        }
    },
}

# ── Piped API — YouTube proxy that bypasses datacenter IP blocks ───────────────
# Piped fetches from YouTube on its own servers, so Railway's blocked IP is
# never exposed to YouTube's bot detection.
PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://api.piped.projectsegfau.lt",
    "https://piped-api.garudalinux.org",
    "https://watchapi.whatever.social",
    "https://api.piped.yt",
]


def _extract_yt_id(url: str) -> str | None:
    """Extract the 11-char video ID from any YouTube URL format."""
    m = re.search(r"(?:v=|youtu\.be/|/shorts/|/embed/)([a-zA-Z0-9_-]{11})", url)
    return m.group(1) if m else None


def _piped_streams(video_id: str) -> list[dict]:
    """
    Fetch audio stream URL for a video ID via Piped instances.
    Tries multiple instances until one works.
    """
    for base in PIPED_INSTANCES:
        try:
            url = f"{base}/streams/{video_id}"
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())

            if "error" in data or not data.get("audioStreams"):
                continue

            # Pick highest-bitrate audio stream
            best = sorted(
                data["audioStreams"],
                key=lambda x: x.get("bitrate", 0),
                reverse=True,
            )[0]

            stream_url = best.get("url", "")
            if not stream_url:
                continue

            print(f"[sonyx] Piped ✅ {base} — {data.get('title', video_id)}")
            return [{
                "title":       data.get("title", "Unknown"),
                "uploader":    data.get("uploader", "Unknown"),
                "duration":    int(data.get("duration") or 0),
                "thumbnail":   data.get("thumbnailUrl", ""),
                "webpage_url": f"https://www.youtube.com/watch?v={video_id}",
                "url":         stream_url,
            }]
        except Exception as e:
            print(f"[sonyx] Piped {base} streams error: {e}")
    return []


def _piped_search(query: str, n: int = 1) -> list[dict]:
    """
    Search YouTube via Piped and return stream-ready dicts.
    Falls back through multiple Piped instances.
    """
    for base in PIPED_INSTANCES:
        try:
            search_url = f"{base}/search?q={urllib.parse.quote(query)}&filter=videos"
            req = urllib.request.Request(
                search_url,
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                items = json.loads(resp.read()).get("items", [])

            if not items:
                continue

            results = []
            for item in items:
                if len(results) >= n:
                    break
                vid_path = item.get("url", "")          # e.g. "/watch?v=XXXX"
                m = re.search(r"v=([a-zA-Z0-9_-]{11})", vid_path)
                if not m:
                    continue
                video_id = m.group(1)
                streams  = _piped_streams(video_id)
                if streams:
                    streams[0]["_original_title"] = item.get("title", streams[0]["title"])
                    results.append(streams[0])

            if results:
                return results
        except Exception as e:
            print(f"[sonyx] Piped {base} search error: {e}")
    return []

# URL patterns
_YT_RE = re.compile(
    r"(https?://)?(www\.)?"
    r"(youtube\.com/(watch\?v=|shorts/|playlist\?list=)|youtu\.be/)"
    r"[\w\-]{1,}"
)
_SC_RE  = re.compile(r"https?://(www\.)?soundcloud\.com/")
_SP_RE  = re.compile(r"https?://open\.spotify\.com/(track|album|playlist)/([a-zA-Z0-9]+)")
_AM_RE  = re.compile(r"https?://music\.apple\.com/")
_YT_PL  = re.compile(r"(https?://)?(www\.)?youtube\.com/playlist\?list=[\w\-]+")

# ── Discord setup ─────────────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
intents.voice_states     = True

bot  = commands.Bot(command_prefix=PREFIX, intents=intents, help_command=None)
tree = bot.tree


# ══════════════════════════════════════════════════════════════════════════════
#  Data classes
# ══════════════════════════════════════════════════════════════════════════════

class LoopMode(Enum):
    OFF   = "off"
    SONG  = "song"
    QUEUE = "queue"


class Track:
    """Represents one track in the queue."""
    __slots__ = ("url", "stream_url", "title", "uploader", "duration",
                 "thumbnail", "webpage_url", "requester")

    def __init__(
        self,
        *,
        url: str,
        stream_url: str,
        title: str,
        uploader: str = "Unknown",
        duration: int = 0,
        thumbnail: str = "",
        webpage_url: str = "",
        requester: discord.Member | None = None,
    ):
        self.url         = url
        self.stream_url  = stream_url
        self.title       = title
        self.uploader    = uploader
        self.duration    = duration
        self.thumbnail   = thumbnail
        self.webpage_url = webpage_url or url
        self.requester   = requester

    def format_duration(self) -> str:
        return _fmt_dur(self.duration)


class GuildPlayer:
    """Per-guild music state."""

    def __init__(self, guild: discord.Guild):
        self.guild          = guild
        self.voice_client: discord.VoiceClient | None = None
        self.queue: deque[Track] = deque()
        self.current: Track | None = None
        self.loop_mode      = LoopMode.OFF
        self.volume         = 0.5          # 0.0–1.0
        self.last_activity  = time.monotonic()
        self._play_lock     = asyncio.Lock()
        self.text_channel: discord.TextChannel | None = None

    def is_connected(self) -> bool:
        return self.voice_client is not None and self.voice_client.is_connected()

    def is_playing(self) -> bool:
        return self.voice_client is not None and self.voice_client.is_playing()

    def is_paused(self) -> bool:
        return self.voice_client is not None and self.voice_client.is_paused()


# Global per-guild state store
_players: dict[int, GuildPlayer] = {}


def get_player(guild: discord.Guild) -> GuildPlayer:
    if guild.id not in _players:
        _players[guild.id] = GuildPlayer(guild)
    return _players[guild.id]


# ══════════════════════════════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _fmt_dur(seconds: int) -> str:
    if not seconds:
        return "?"
    h, rem = divmod(int(seconds), 3600)
    m, s   = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _progress_bar(current: int, total: int, length: int = 20) -> str:
    if not total:
        return "─" * length
    filled = int(length * current / total)
    bar    = "█" * filled + "─" * (length - filled)
    return bar


def _build_np_embed(track: Track, vc: discord.VoiceClient) -> discord.Embed:
    embed = discord.Embed(
        title="▶️  Now Playing",
        description=f"**[{track.title}]({track.webpage_url})**",
        color=0x1DB954,
    )
    embed.add_field(name="Channel",   value=track.uploader,             inline=True)
    embed.add_field(name="Duration",  value=track.format_duration(),    inline=True)
    embed.add_field(name="Requested", value=track.requester.mention if track.requester else "?", inline=True)
    if track.thumbnail:
        embed.set_thumbnail(url=track.thumbnail)
    embed.set_footer(text="Sonyx Music Bot")
    return embed


def _build_queue_embed(player: GuildPlayer, page: int = 1) -> discord.Embed:
    queue_list = list(player.queue)
    total      = len(queue_list)
    pages      = max(1, (total + QUEUE_PAGE_SIZE - 1) // QUEUE_PAGE_SIZE)
    page       = max(1, min(page, pages))
    start      = (page - 1) * QUEUE_PAGE_SIZE
    chunk      = queue_list[start:start + QUEUE_PAGE_SIZE]

    embed = discord.Embed(title="🎶  Queue", color=0x1DB954)

    if player.current:
        embed.add_field(
            name="Now Playing",
            value=f"**[{player.current.title}]({player.current.webpage_url})** `{player.current.format_duration()}`",
            inline=False,
        )

    if not chunk:
        embed.description = "The queue is empty."
    else:
        lines = []
        for i, t in enumerate(chunk, start=start + 1):
            lines.append(f"`{i}.` **{t.title}** `{t.format_duration()}`")
        embed.add_field(name=f"Up Next — Page {page}/{pages}", value="\n".join(lines), inline=False)

    loop_label = {"off": "🔁 Off", "song": "🔂 Song", "queue": "🔁 Queue"}[player.loop_mode.value]
    embed.set_footer(text=f"{total} track(s) in queue  •  Loop: {loop_label}  •  Vol: {int(player.volume * 100)}%")
    return embed


# ══════════════════════════════════════════════════════════════════════════════
#  Platform resolvers — all return list[dict] with keys:
#    title, uploader, duration, thumbnail, webpage_url, search_query
# ══════════════════════════════════════════════════════════════════════════════

def _ydl_extract(query: str, playlist: bool = False) -> list[dict]:
    """Core yt-dlp extraction. Returns list of info dicts."""
    opts = dict(YDL_BASE)
    if playlist:
        opts.pop("noplaylist", None)
        opts["noplaylist"] = False
        opts["playlistend"] = MAX_PLAYLIST_TRACKS
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(query, download=False)
    if not info:
        return []
    if "entries" in info:
        return [e for e in info["entries"] if e]
    return [info]


def _fetch_yt_oembed(url: str) -> dict | None:
    """
    Hit YouTube's unauthenticated oEmbed endpoint to get title + author.
    Returns dict with 'title', 'author_name', 'thumbnail_url' or None on failure.
    """
    try:
        encoded = urllib.parse.quote(url, safe="")
        oembed_url = f"https://www.youtube.com/oembed?url={encoded}&format=json"
        req = urllib.request.Request(
            oembed_url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Sonyx/1.0)"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"[sonyx] oEmbed failed: {e}")
        return None


def _resolve_youtube(url: str) -> list[dict]:
    """
    YouTube resolution — three-layer approach:
      1. Piped API (video ID → direct stream, no YouTube auth)
      2. oEmbed → Piped search (title-based search via Piped)
      3. yt-dlp fallback (last resort, may hit bot detection)
    """
    if _YT_PL.search(url):
        return _ydl_extract(url, playlist=True)

    # Layer 1: direct Piped lookup by video ID (fastest, most reliable)
    video_id = _extract_yt_id(url)
    if video_id:
        result = _piped_streams(video_id)
        if result:
            return result

    # Layer 2: oEmbed → Piped search by title
    meta = _fetch_yt_oembed(url)
    if meta:
        title  = meta.get("title", "").strip()
        author = meta.get("author_name", "").strip()
        query  = f"{title} {author}".strip()
        print(f"[sonyx] YouTube → Piped search: '{query}'")
        results = _piped_search(query)
        if results:
            results[0]["_original_title"] = title
            results[0].setdefault("uploader", author)
            if meta.get("thumbnail_url"):
                results[0].setdefault("thumbnail", meta["thumbnail_url"])
            return results
        # Piped search also failed — try yt-dlp ytsearch
        results = _ydl_extract(f"ytsearch1:{query}", playlist=False)
        if results:
            results[0]["_original_title"] = title
            return results

    # Layer 3: direct yt-dlp (likely bot-detected on Railway, but try anyway)
    print("[sonyx] All YouTube bridges failed, trying direct yt-dlp…")
    return _ydl_extract(url, playlist=False)


def _resolve_soundcloud(url: str) -> list[dict]:
    """
    SoundCloud: extract title via yt-dlp metadata-only mode, then search
    via Piped (YouTube) so we avoid Railway IP issues.
    """
    try:
        opts = dict(YDL_BASE)
        opts["extract_flat"] = True
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if info:
            title  = info.get("title", "").strip()
            author = info.get("uploader") or info.get("channel") or ""
            if title:
                query = f"{title} {author}".strip()
                results = _piped_search(query)
                if results:
                    results[0]["_original_title"] = title
                    results[0].setdefault("uploader", author)
                    return results
                # Piped failed — try yt-dlp ytsearch
                results = _ydl_extract(f"ytsearch1:{query}", playlist=False)
                if results:
                    results[0]["_original_title"] = title
                    return results
    except Exception as e:
        print(f"[sonyx] SoundCloud bridge error: {e}")
    return _ydl_extract(url)


def _resolve_spotify(url: str) -> list[dict]:
    """
    Uses spotipy to extract metadata, then searches YouTube.
    Falls back to regex+search if spotipy is unavailable.
    """
    match = _SP_RE.search(url)
    if not match:
        return []
    kind, sp_id = match.group(1), match.group(2)

    results: list[dict] = []

    if SPOTIFY_ENABLED and _sp:
        try:
            if kind == "track":
                data   = _sp.track(sp_id)
                artist = data["artists"][0]["name"]
                title  = data["name"]
                query  = f"{artist} {title}"
                hits   = _piped_search(query) or _ydl_extract(f"ytsearch1:{query} audio", playlist=False)
                if hits:
                    hits[0]["_original_title"] = f"{artist} — {title}"
                    results = hits

            elif kind == "album":
                data   = _sp.album(sp_id)
                tracks = data["tracks"]["items"][:MAX_PLAYLIST_TRACKS]
                for t in tracks:
                    artist = t["artists"][0]["name"]
                    title  = t["name"]
                    query  = f"{artist} {title}"
                    hits   = _piped_search(query) or _ydl_extract(f"ytsearch1:{query} audio", playlist=False)
                    if hits:
                        hits[0]["_original_title"] = f"{artist} — {title}"
                        results.extend(hits)

            elif kind == "playlist":
                data  = _sp.playlist_tracks(sp_id, limit=MAX_PLAYLIST_TRACKS)
                items = [i["track"] for i in data["items"] if i.get("track")]
                for t in items:
                    artist = t["artists"][0]["name"]
                    title  = t["name"]
                    query  = f"{artist} {title}"
                    hits   = _piped_search(query) or _ydl_extract(f"ytsearch1:{query} audio", playlist=False)
                    if hits:
                        hits[0]["_original_title"] = f"{artist} — {title}"
                        results.extend(hits)
        except Exception as e:
            print(f"[sonyx] Spotify resolve error: {e}")

    else:
        # Graceful fallback: scrape Open Graph title from the Spotify page URL
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                html = resp.read(32768).decode("utf-8", errors="ignore")
            og_title = re.search(r'<meta property="og:title" content="([^"]+)"', html)
            og_desc  = re.search(r'<meta property="og:description" content="([^"]+)"', html)
            query    = og_title.group(1) if og_title else ""
            if og_desc:
                query += " " + og_desc.group(1).split("·")[0].strip()
            if query:
                q = query.strip()
                results = _piped_search(q) or _ydl_extract(f"ytsearch1:{q} audio", playlist=False)
        except Exception as e:
            print(f"[sonyx] Spotify OG-title fallback error: {e}")

    return results


def _resolve_apple_music(url: str) -> list[dict]:
    """
    Extracts track/artist from Apple Music's Open Graph tags, then searches YouTube.
    Apple Music embeds og:title as 'Song – Artist' or 'Album by Artist'.
    """
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read(32768).decode("utf-8", errors="ignore")

        og_title = re.search(r'<meta property="og:title"\s+content="([^"]+)"', html)
        og_desc  = re.search(r'<meta property="og:description"\s+content="([^"]+)"', html)

        if not og_title:
            return []

        raw_title = og_title.group(1)
        # Apple Music format: "Song Name – Artist Name" or "Album by Artist"
        if " – " in raw_title:
            song, artist = raw_title.split(" – ", 1)
        elif og_desc:
            song   = raw_title
            desc   = og_desc.group(1)
            # Description often starts with "Artist · Album"
            artist = desc.split("·")[0].strip() if "·" in desc else ""
        else:
            song, artist = raw_title, ""

        query   = f"{song} {artist}".strip()
        results = _piped_search(query) or _ydl_extract(f"ytsearch1:{query} audio", playlist=False)
        if results:
            results[0]["_original_title"] = f"{song} — {artist}" if artist else song
        return results

    except Exception as e:
        print(f"[sonyx] Apple Music resolve error: {e}")
        return []


def _resolve_text_search(query: str, n: int = 1) -> list[dict]:
    """Search via Piped (no YouTube auth), fall back to yt-dlp."""
    results = _piped_search(query, n)
    if results:
        return results
    # Piped all instances down — fall back to yt-dlp
    print(f"[sonyx] All Piped instances failed for '{query}', falling back to yt-dlp")
    try:
        return _ydl_extract(f"ytsearch{n}:{query}", playlist=False)
    except Exception:
        return []


async def resolve_input(
    raw: str,
    requester: discord.Member | None = None,
    n_search: int = 1,
) -> list[Track]:
    """
    Resolves any user input (URL or search text) to a list of Track objects.
    Runs yt-dlp in an executor thread so we don't block the event loop.
    """
    raw = raw.strip()
    loop = asyncio.get_running_loop()

    def _sync_resolve() -> list[dict]:
        if _SP_RE.search(raw):
            return _resolve_spotify(raw)
        if _AM_RE.search(raw):
            return _resolve_apple_music(raw)
        if _SC_RE.search(raw):
            return _resolve_soundcloud(raw)
        if _YT_RE.search(raw):
            return _resolve_youtube(raw)
        # Plain text search
        return _resolve_text_search(raw, n=n_search)

    infos = await loop.run_in_executor(None, _sync_resolve)

    tracks: list[Track] = []
    for info in infos:
        if not info:
            continue
        # Get the best stream URL
        stream_url = info.get("url") or info.get("formats", [{}])[-1].get("url", "")
        if not stream_url:
            # Re-extract with full details if the flat entry has no URL
            try:
                detailed = await loop.run_in_executor(
                    None, lambda: _ydl_extract(info.get("webpage_url") or info.get("url", ""))
                )
                if detailed:
                    info = detailed[0]
                    stream_url = info.get("url", "")
            except Exception:
                pass

        title     = info.get("_original_title") or info.get("title") or "Unknown"
        uploader  = info.get("uploader") or info.get("channel") or "Unknown"
        duration  = int(info.get("duration") or 0)
        thumbnail = info.get("thumbnail") or ""
        webpage   = info.get("webpage_url") or info.get("url") or raw

        # Pick the best thumbnail if it's a list
        thumbs = info.get("thumbnails")
        if thumbs and isinstance(thumbs, list):
            # Prefer 640-width or the last (highest res) entry
            chosen = sorted(thumbs, key=lambda t: t.get("width", 0) or 0)
            if chosen:
                thumbnail = chosen[-1].get("url", thumbnail)

        tracks.append(Track(
            url=raw,
            stream_url=stream_url,
            title=title,
            uploader=uploader,
            duration=duration,
            thumbnail=thumbnail,
            webpage_url=webpage,
            requester=requester,
        ))

    return tracks


async def refresh_stream_url(track: Track) -> str:
    """Re-fetch stream URL (YouTube URLs expire after ~6h)."""
    loop = asyncio.get_running_loop()
    def _fetch():
        results = _ydl_extract(track.webpage_url)
        if results:
            return results[0].get("url", "")
        return ""
    return await loop.run_in_executor(None, _fetch)


# ══════════════════════════════════════════════════════════════════════════════
#  Playback engine
# ══════════════════════════════════════════════════════════════════════════════

async def play_next(guild_id: int):
    """Pick the next track from the queue and start playback."""
    player = _players.get(guild_id)
    if not player or not player.is_connected():
        return

    async with player._play_lock:
        if player.is_playing():
            return

        # Loop: song → replay current
        if player.loop_mode == LoopMode.SONG and player.current:
            next_track = player.current
        elif player.queue:
            next_track = player.queue.popleft()
            if player.loop_mode == LoopMode.QUEUE and player.current:
                player.queue.append(player.current)
            player.current = next_track
        else:
            player.current = None
            player.last_activity = time.monotonic()
            return

        player.last_activity = time.monotonic()

        # Refresh stream URL in case it expired
        stream_url = next_track.stream_url
        if not stream_url:
            stream_url = await refresh_stream_url(next_track)
            next_track.stream_url = stream_url

        if not stream_url:
            if player.text_channel:
                await player.text_channel.send(
                    f"⚠️  Could not stream **{next_track.title}** — skipping."
                )
            asyncio.create_task(play_next(guild_id))
            return

        # Apply volume to ffmpeg options
        vol_opts = dict(FFMPEG_OPTS)
        vol_opts["options"] = f"-vn -af volume={player.volume}"

        try:
            source = await discord.FFmpegOpusAudio.from_probe(
                stream_url,
                before_options=vol_opts["before_options"],
                options=vol_opts["options"],
            )
        except Exception as e:
            print(f"[sonyx] FFmpeg probe failed: {e}")
            if player.text_channel:
                await player.text_channel.send(
                    f"⚠️  Could not play **{next_track.title}** — skipping."
                )
            asyncio.create_task(play_next(guild_id))
            return

        def _after(error):
            if error:
                print(f"[sonyx] Playback error: {error}")
            asyncio.run_coroutine_threadsafe(play_next(guild_id), bot.loop)

        player.voice_client.play(source, after=_after)

        # Announce in text channel
        if player.text_channel:
            embed = _build_np_embed(next_track, player.voice_client)
            try:
                await player.text_channel.send(embed=embed)
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════════════════════
#  Background task — inactivity watchdog
# ══════════════════════════════════════════════════════════════════════════════

@tasks.loop(seconds=30)
async def inactivity_watchdog():
    now = time.monotonic()
    to_disconnect: list[int] = []

    for gid, player in _players.items():
        if not player.is_connected():
            continue
        if player.is_playing() or player.is_paused():
            player.last_activity = now
            continue
        if now - player.last_activity > INACTIVITY_TIMEOUT:
            to_disconnect.append(gid)

    for gid in to_disconnect:
        player = _players.get(gid)
        if player and player.is_connected():
            if player.text_channel:
                try:
                    await player.text_channel.send(
                        "👋  Left the voice channel due to inactivity."
                    )
                except Exception:
                    pass
            await player.voice_client.disconnect(force=True)
            player.voice_client = None
            player.queue.clear()
            player.current = None


# ══════════════════════════════════════════════════════════════════════════════
#  Shared command logic
# ══════════════════════════════════════════════════════════════════════════════

async def _ensure_voice(ctx_or_interaction) -> discord.VoiceClient | None:
    """Connect to the author's VC if not already connected. Returns VoiceClient or None."""
    is_ix = isinstance(ctx_or_interaction, discord.Interaction)
    author = ctx_or_interaction.user if is_ix else ctx_or_interaction.author
    guild  = ctx_or_interaction.guild

    if not hasattr(author, "voice") or not author.voice or not author.voice.channel:
        msg = "❌  You need to be in a voice channel first."
        if is_ix:
            await ctx_or_interaction.followup.send(msg, ephemeral=True)
        else:
            await ctx_or_interaction.reply(msg)
        return None

    vc_channel = author.voice.channel
    player     = get_player(guild)

    if player.is_connected():
        if player.voice_client.channel != vc_channel:
            await player.voice_client.move_to(vc_channel)
    else:
        try:
            player.voice_client = await vc_channel.connect()
        except Exception as e:
            msg = f"❌  Could not connect to voice channel: {e}"
            if is_ix:
                await ctx_or_interaction.followup.send(msg, ephemeral=True)
            else:
                await ctx_or_interaction.reply(msg)
            return None

    return player.voice_client


async def _quick_reply(ctx_or_interaction, content=None, embed=None, ephemeral=False):
    is_ix = isinstance(ctx_or_interaction, discord.Interaction)
    try:
        if is_ix:
            if ctx_or_interaction.response.is_done():
                await ctx_or_interaction.followup.send(content=content, embed=embed, ephemeral=ephemeral)
            else:
                await ctx_or_interaction.response.send_message(content=content, embed=embed, ephemeral=ephemeral)
        else:
            await ctx_or_interaction.reply(content=content, embed=embed)
    except discord.Forbidden:
        try:
            chan = ctx_or_interaction.channel if not is_ix else ctx_or_interaction.channel
            if embed:
                await chan.send(content=f"**{embed.title or ''}** {content or ''}")
            else:
                await chan.send(content=content)
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
#  Search result selection helper
# ══════════════════════════════════════════════════════════════════════════════

async def _interactive_search(ctx: commands.Context, query: str) -> Track | None:
    """Show top N search results and let the user pick one."""
    status_msg = await ctx.reply(f"🔍  Searching for `{query}`…")
    loop       = asyncio.get_running_loop()

    try:
        infos = await loop.run_in_executor(
            None, lambda: _resolve_text_search(query, n=SEARCH_RESULTS)
        )
    except Exception as e:
        await status_msg.edit(content=f"❌  Search failed: {e}")
        return None

    if not infos:
        await status_msg.edit(content="❌  No results found.")
        return None

    lines = []
    for i, info in enumerate(infos, 1):
        dur   = _fmt_dur(int(info.get("duration") or 0))
        title = info.get("title", "Unknown")[:60]
        lines.append(f"`{i}.` **{title}** `{dur}`")

    embed = discord.Embed(
        title=f"🎵  Search results for: {query}",
        description="\n".join(lines),
        color=0x1DB954,
    )
    embed.set_footer(text=f"Type a number 1–{len(infos)} to pick, or 'cancel'  •  Timeout: 30s")
    await status_msg.edit(content=None, embed=embed)

    def check(m: discord.Message):
        return (
            m.author == ctx.author
            and m.channel == ctx.channel
            and (m.content.lower() in ("cancel", "c") or m.content.isdigit())
        )

    try:
        reply = await bot.wait_for("message", timeout=30.0, check=check)
    except asyncio.TimeoutError:
        await status_msg.edit(embed=None, content="⏰  Search timed out.")
        return None

    if reply.content.lower() in ("cancel", "c"):
        await status_msg.edit(embed=None, content="❌  Search cancelled.")
        return None

    pick = int(reply.content)
    if pick < 1 or pick > len(infos):
        await status_msg.edit(embed=None, content="❌  Invalid selection.")
        return None

    chosen = infos[pick - 1]
    await status_msg.delete()

    # Build full Track from the chosen result
    tracks = await resolve_input(
        chosen.get("webpage_url") or chosen.get("url") or query,
        requester=ctx.author,
    )
    return tracks[0] if tracks else None


# ══════════════════════════════════════════════════════════════════════════════
#  PREFIX COMMANDS
# ══════════════════════════════════════════════════════════════════════════════

# ── !play ─────────────────────────────────────────────────────────────────────
@bot.command(name="play", aliases=["p"])
@commands.cooldown(1, COOLDOWN_SECONDS, commands.BucketType.user)
async def cmd_play(ctx: commands.Context, *, query: str = ""):
    """Play or queue a song. Accepts URLs or search text."""
    if not query:
        await ctx.reply("❌  Provide a URL or search query. Example: `{PREFIX}play never gonna give you up`")
        return

    # Join VC
    vc = await _ensure_voice(ctx)
    if not vc:
        return

    player = get_player(ctx.guild)
    player.text_channel = ctx.channel

    # Detect if it's a plain-text search → interactive picker
    is_url = any(pat.search(query) for pat in (_YT_RE, _SC_RE, _SP_RE, _AM_RE))

    if is_url:
        status = await ctx.reply("⏳  Loading…")
        try:
            tracks = await resolve_input(query, requester=ctx.author)
        except Exception as e:
            await status.edit(content=f"❌  Error: {e}")
            return

        if not tracks:
            await status.edit(content="❌  Could not resolve that URL.")
            return

        await status.delete()

        if len(tracks) == 1:
            player.queue.append(tracks[0])
            added_msg = f"✅  Added to queue: **{tracks[0].title}**"
        else:
            for t in tracks:
                player.queue.append(t)
            added_msg = f"✅  Added **{len(tracks)} tracks** to the queue."
        await ctx.send(added_msg)
    else:
        # Text search — interactive 5-result picker
        track = await _interactive_search(ctx, query)
        if not track:
            return
        track.requester = ctx.author
        player.queue.append(track)
        await ctx.send(f"✅  Added to queue: **{track.title}**")

    if not player.is_playing() and not player.is_paused():
        await play_next(ctx.guild.id)


@cmd_play.error
async def cmd_play_error(ctx: commands.Context, error):
    if isinstance(error, commands.CommandOnCooldown):
        await ctx.reply(
            f"⏳  Slow down! You can use `{PREFIX}play` again in **{error.retry_after:.0f}s**.",
            delete_after=8,
        )
    elif isinstance(error, commands.MissingRequiredArgument):
        await ctx.reply(f"❌  Usage: `{PREFIX}play <url or search>`")
    else:
        raise error


# ── !pause ────────────────────────────────────────────────────────────────────
@bot.command(name="pause")
async def cmd_pause(ctx: commands.Context):
    player = get_player(ctx.guild)
    if player.is_playing():
        player.voice_client.pause()
        await ctx.reply("⏸  Paused.")
    else:
        await ctx.reply("❌  Nothing is playing.")


# ── !resume ───────────────────────────────────────────────────────────────────
@bot.command(name="resume", aliases=["r"])
async def cmd_resume(ctx: commands.Context):
    player = get_player(ctx.guild)
    if player.is_paused():
        player.voice_client.resume()
        player.last_activity = time.monotonic()
        await ctx.reply("▶️  Resumed.")
    else:
        await ctx.reply("❌  Nothing is paused.")


# ── !skip ─────────────────────────────────────────────────────────────────────
@bot.command(name="skip", aliases=["s"])
async def cmd_skip(ctx: commands.Context):
    player = get_player(ctx.guild)
    if player.is_playing() or player.is_paused():
        player.voice_client.stop()     # triggers after() → play_next
        await ctx.reply("⏭  Skipped.")
    else:
        await ctx.reply("❌  Nothing is playing.")


# ── !stop ─────────────────────────────────────────────────────────────────────
@bot.command(name="stop")
async def cmd_stop(ctx: commands.Context):
    player = get_player(ctx.guild)
    if player.is_connected():
        player.queue.clear()
        player.current = None
        player.loop_mode = LoopMode.OFF
        player.voice_client.stop()
        await player.voice_client.disconnect(force=True)
        player.voice_client = None
        await ctx.reply("⏹  Stopped and disconnected.")
    else:
        await ctx.reply("❌  Not connected to a voice channel.")


# ── !queue ────────────────────────────────────────────────────────────────────
@bot.command(name="queue", aliases=["q"])
async def cmd_queue(ctx: commands.Context, page: int = 1):
    player = get_player(ctx.guild)
    embed  = _build_queue_embed(player, page)
    await ctx.reply(embed=embed)


# ── !nowplaying ───────────────────────────────────────────────────────────────
@bot.command(name="nowplaying", aliases=["np"])
async def cmd_nowplaying(ctx: commands.Context):
    player = get_player(ctx.guild)
    if not player.current:
        await ctx.reply("❌  Nothing is playing right now.")
        return
    embed = _build_np_embed(player.current, player.voice_client)
    await ctx.reply(embed=embed)


# ── !volume ───────────────────────────────────────────────────────────────────
@bot.command(name="volume", aliases=["vol"])
async def cmd_volume(ctx: commands.Context, vol: int = -1):
    if vol < 0 or vol > 100:
        await ctx.reply("❌  Provide a value between 0 and 100. Example: `{PREFIX}volume 75`")
        return
    player = get_player(ctx.guild)
    player.volume = vol / 100
    # Restart playback with new volume if currently playing
    if player.is_playing():
        player.voice_client.stop()   # will trigger play_next with new volume
    await ctx.reply(f"🔊  Volume set to **{vol}%**.")


# ── !loop ─────────────────────────────────────────────────────────────────────
@bot.command(name="loop")
async def cmd_loop(ctx: commands.Context):
    player   = get_player(ctx.guild)
    modes    = list(LoopMode)
    cur_idx  = modes.index(player.loop_mode)
    player.loop_mode = modes[(cur_idx + 1) % len(modes)]
    labels   = {LoopMode.OFF: "Off 🔁", LoopMode.SONG: "Song 🔂", LoopMode.QUEUE: "Queue 🔁"}
    await ctx.reply(f"Loop mode: **{labels[player.loop_mode]}**")


# ── !shuffle ──────────────────────────────────────────────────────────────────
@bot.command(name="shuffle")
async def cmd_shuffle(ctx: commands.Context):
    player = get_player(ctx.guild)
    if len(player.queue) < 2:
        await ctx.reply("❌  Not enough tracks in queue to shuffle.")
        return
    lst = list(player.queue)
    random.shuffle(lst)
    player.queue = deque(lst)
    await ctx.reply("🔀  Queue shuffled!")


# ── !remove ───────────────────────────────────────────────────────────────────
@bot.command(name="remove")
async def cmd_remove(ctx: commands.Context, pos: int = 0):
    player = get_player(ctx.guild)
    if pos < 1 or pos > len(player.queue):
        await ctx.reply(f"❌  Invalid position. Queue has {len(player.queue)} track(s).")
        return
    lst = list(player.queue)
    removed = lst.pop(pos - 1)
    player.queue = deque(lst)
    await ctx.reply(f"🗑  Removed: **{removed.title}**")


# ── !clear ────────────────────────────────────────────────────────────────────
@bot.command(name="clear")
async def cmd_clear(ctx: commands.Context):
    player = get_player(ctx.guild)
    player.queue.clear()
    await ctx.reply("🗑  Queue cleared.")


# ── !seek ─────────────────────────────────────────────────────────────────────
@bot.command(name="seek")
async def cmd_seek(ctx: commands.Context, *, position: str = ""):
    """Seek to a position. Accepts seconds (e.g. 90) or mm:ss (e.g. 1:30)."""
    player = get_player(ctx.guild)
    if not player.current:
        await ctx.reply("❌  Nothing is playing.")
        return

    # Parse position
    seconds = 0
    try:
        if ":" in position:
            parts   = position.split(":")
            seconds = int(parts[0]) * 60 + int(parts[1])
        else:
            seconds = int(position)
    except (ValueError, IndexError):
        await ctx.reply("❌  Invalid time format. Use seconds (e.g. `90`) or mm:ss (e.g. `1:30`).")
        return

    track = player.current
    if track.duration and seconds > track.duration:
        await ctx.reply(f"❌  Seek position exceeds track duration ({track.format_duration()}).")
        return

    # Re-stream from offset using FFmpeg -ss flag
    stream_url = track.stream_url or await refresh_stream_url(track)

    vol_opts = dict(FFMPEG_OPTS)
    vol_opts["before_options"] = f"-ss {seconds} " + vol_opts["before_options"]
    vol_opts["options"]        = f"-vn -af volume={player.volume}"

    try:
        source = await discord.FFmpegOpusAudio.from_probe(
            stream_url,
            before_options=vol_opts["before_options"],
            options=vol_opts["options"],
        )
    except Exception as e:
        await ctx.reply(f"❌  Seek failed: {e}")
        return

    def _after(error):
        if error:
            print(f"[sonyx] Seek playback error: {error}")
        asyncio.run_coroutine_threadsafe(play_next(ctx.guild.id), bot.loop)

    player.voice_client.stop()
    player.voice_client.play(source, after=_after)
    await ctx.reply(f"⏩  Seeked to `{_fmt_dur(seconds)}`.")


# ── !ytinfo ───────────────────────────────────────────────────────────────────
@bot.command(name="ytinfo")
async def cmd_ytinfo(ctx: commands.Context, *, url: str = ""):
    """Preview a video's info without downloading or playing."""
    if not url:
        await ctx.reply(f"❌  Usage: `{PREFIX}ytinfo <url>`")
        return

    status = await ctx.reply("🔍  Fetching info…")
    try:
        tracks = await resolve_input(url)
    except Exception as e:
        await status.edit(content=f"❌  Error: {e}")
        return

    if not tracks:
        await status.edit(content="❌  Could not fetch info for that URL.")
        return

    t = tracks[0]
    embed = discord.Embed(
        title=t.title,
        url=t.webpage_url,
        color=0xFF0000,
    )
    embed.add_field(name="Channel",  value=t.uploader,          inline=True)
    embed.add_field(name="Duration", value=t.format_duration(), inline=True)
    if t.thumbnail:
        embed.set_image(url=t.thumbnail)
    embed.set_footer(text="Use !play <url> to add this to the queue.")
    await status.edit(content=None, embed=embed)


# ── !lyrics ───────────────────────────────────────────────────────────────────
@bot.command(name="lyrics", aliases=["ly"])
async def cmd_lyrics(ctx: commands.Context, *, query: str = ""):
    """Fetch and display lyrics. Leave blank to use the current song."""
    player = get_player(ctx.guild)

    if not query:
        if player.current:
            query = player.current.title
        else:
            await ctx.reply("❌  Provide a song name or start playing something.")
            return

    if not LYRICS_ENABLED:
        await ctx.reply("❌  Lyrics module not installed. Run `pip install syncedlyrics`.")
        return

    status = await ctx.reply(f"🔍  Fetching lyrics for **{query}**…")

    def _fetch():
        try:
            return syncedlyrics.search(query, plain_only=True, enhanced=False)
        except Exception:
            return None

    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _fetch)

    if not result:
        await status.edit(content=f"❌  No lyrics found for **{query}**.")
        return

    # Strip LRC timestamps if any
    clean = re.sub(r"\[\d+:\d+\.\d+\]\s*", "", result).strip()

    # Discord has a 4096 char embed description limit
    chunks = textwrap.wrap(clean, width=3900, break_long_words=False, replace_whitespace=False)
    first  = chunks[0] if chunks else clean

    embed = discord.Embed(
        title=f"🎵  Lyrics — {query}",
        description=first,
        color=0x1DB954,
    )
    if len(chunks) > 1:
        embed.set_footer(text=f"Showing first portion • {len(chunks)} pages total")
    await status.edit(content=None, embed=embed)


# ── !ping ─────────────────────────────────────────────────────────────────────
@bot.command(name="ping")
async def cmd_ping(ctx: commands.Context):
    latency = round(bot.latency * 1000)
    await ctx.reply(f"🏓  Pong! Latency: **{latency}ms**")


# ── !help ─────────────────────────────────────────────────────────────────────
@bot.command(name="help", aliases=["h"])
async def cmd_help(ctx: commands.Context):
    p = PREFIX
    embed = discord.Embed(
        title="🎵  Sonyx Music Bot — Help",
        description="A full-featured music bot. Stream from YouTube, SoundCloud, Spotify & Apple Music.",
        color=0x1DB954,
    )
    embed.add_field(
        name="▶️  Playback",
        value=(
            f"`{p}play <url/search>` / `{p}p` — Play or queue a song\n"
            f"`{p}pause` — Pause\n"
            f"`{p}resume` / `{p}r` — Resume\n"
            f"`{p}skip` / `{p}s` — Skip current track\n"
            f"`{p}stop` — Stop and disconnect\n"
            f"`{p}seek <time>` — Seek to a position (e.g. `1:30` or `90`)\n"
            f"`{p}volume <0–100>` / `{p}vol` — Set volume"
        ),
        inline=False,
    )
    embed.add_field(
        name="📋  Queue",
        value=(
            f"`{p}queue [page]` / `{p}q` — Show queue\n"
            f"`{p}nowplaying` / `{p}np` — Current track\n"
            f"`{p}loop` — Cycle loop mode (off → song → queue)\n"
            f"`{p}shuffle` — Shuffle queue\n"
            f"`{p}remove <pos>` — Remove a track\n"
            f"`{p}clear` — Clear entire queue"
        ),
        inline=False,
    )
    embed.add_field(
        name="🔍  Info",
        value=(
            f"`{p}ytinfo <url>` — Preview without playing\n"
            f"`{p}lyrics [song]` / `{p}ly` — Fetch lyrics"
        ),
        inline=False,
    )
    embed.add_field(
        name="🌐  Supported Platforms",
        value="YouTube • SoundCloud • Spotify • Apple Music",
        inline=False,
    )
    embed.add_field(
        name="⚙️  Utility",
        value=f"`{p}ping` — Latency check\n`{p}help` — This message",
        inline=False,
    )
    embed.set_footer(text="All commands also available as /slash commands  •  30s cooldown on !play")
    await ctx.reply(embed=embed)


# ══════════════════════════════════════════════════════════════════════════════
#  SLASH COMMANDS
# ══════════════════════════════════════════════════════════════════════════════

@tree.command(name="play", description="Play or queue a song (URL or search text)")
@app_commands.describe(query="YouTube/Spotify/SoundCloud/Apple Music URL, or a song name to search")
async def slash_play(interaction: discord.Interaction, query: str):
    await interaction.response.defer(thinking=True)

    author = interaction.user
    guild  = interaction.guild

    if not hasattr(author, "voice") or not author.voice or not author.voice.channel:
        await interaction.followup.send("❌  Join a voice channel first.", ephemeral=True)
        return

    player = get_player(guild)
    player.text_channel = interaction.channel

    if not player.is_connected():
        try:
            player.voice_client = await author.voice.channel.connect()
        except Exception as e:
            await interaction.followup.send(f"❌  Could not connect: {e}", ephemeral=True)
            return

    try:
        tracks = await resolve_input(query, requester=author)
    except Exception as e:
        await interaction.followup.send(f"❌  Error: {e}", ephemeral=True)
        return

    if not tracks:
        await interaction.followup.send("❌  No results found.", ephemeral=True)
        return

    for t in tracks:
        player.queue.append(t)

    if len(tracks) == 1:
        msg = f"✅  Added to queue: **{tracks[0].title}**"
    else:
        msg = f"✅  Added **{len(tracks)} tracks** to the queue."
    await interaction.followup.send(msg)

    if not player.is_playing() and not player.is_paused():
        await play_next(guild.id)


@tree.command(name="skip", description="Skip the current track")
async def slash_skip(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    if player.is_playing() or player.is_paused():
        player.voice_client.stop()
        await interaction.response.send_message("⏭  Skipped.")
    else:
        await interaction.response.send_message("❌  Nothing is playing.", ephemeral=True)


@tree.command(name="pause", description="Pause playback")
async def slash_pause(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    if player.is_playing():
        player.voice_client.pause()
        await interaction.response.send_message("⏸  Paused.")
    else:
        await interaction.response.send_message("❌  Nothing is playing.", ephemeral=True)


@tree.command(name="resume", description="Resume playback")
async def slash_resume(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    if player.is_paused():
        player.voice_client.resume()
        player.last_activity = time.monotonic()
        await interaction.response.send_message("▶️  Resumed.")
    else:
        await interaction.response.send_message("❌  Nothing is paused.", ephemeral=True)


@tree.command(name="stop", description="Stop music and disconnect the bot")
async def slash_stop(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    if player.is_connected():
        player.queue.clear()
        player.current = None
        player.loop_mode = LoopMode.OFF
        player.voice_client.stop()
        await player.voice_client.disconnect(force=True)
        player.voice_client = None
        await interaction.response.send_message("⏹  Stopped and disconnected.")
    else:
        await interaction.response.send_message("❌  Not connected.", ephemeral=True)


@tree.command(name="queue", description="Show the current queue")
@app_commands.describe(page="Page number")
async def slash_queue(interaction: discord.Interaction, page: int = 1):
    player = get_player(interaction.guild)
    embed  = _build_queue_embed(player, page)
    await interaction.response.send_message(embed=embed)


@tree.command(name="nowplaying", description="Show the currently playing track")
async def slash_nowplaying(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    if not player.current:
        await interaction.response.send_message("❌  Nothing is playing.", ephemeral=True)
        return
    embed = _build_np_embed(player.current, player.voice_client)
    await interaction.response.send_message(embed=embed)


@tree.command(name="volume", description="Set the playback volume (0–100)")
@app_commands.describe(level="Volume level between 0 and 100")
async def slash_volume(interaction: discord.Interaction, level: int):
    if level < 0 or level > 100:
        await interaction.response.send_message("❌  Volume must be 0–100.", ephemeral=True)
        return
    player = get_player(interaction.guild)
    player.volume = level / 100
    if player.is_playing():
        player.voice_client.stop()
    await interaction.response.send_message(f"🔊  Volume set to **{level}%**.")


@tree.command(name="loop", description="Cycle loop mode: off → song → queue")
async def slash_loop(interaction: discord.Interaction):
    player   = get_player(interaction.guild)
    modes    = list(LoopMode)
    cur_idx  = modes.index(player.loop_mode)
    player.loop_mode = modes[(cur_idx + 1) % len(modes)]
    labels   = {LoopMode.OFF: "Off 🔁", LoopMode.SONG: "Song 🔂", LoopMode.QUEUE: "Queue 🔁"}
    await interaction.response.send_message(f"Loop mode: **{labels[player.loop_mode]}**")


@tree.command(name="shuffle", description="Shuffle the queue")
async def slash_shuffle(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    if len(player.queue) < 2:
        await interaction.response.send_message("❌  Not enough tracks to shuffle.", ephemeral=True)
        return
    lst = list(player.queue)
    random.shuffle(lst)
    player.queue = deque(lst)
    await interaction.response.send_message("🔀  Queue shuffled!")


@tree.command(name="remove", description="Remove a track from the queue by position")
@app_commands.describe(position="Queue position to remove (1-indexed)")
async def slash_remove(interaction: discord.Interaction, position: int):
    player = get_player(interaction.guild)
    if position < 1 or position > len(player.queue):
        await interaction.response.send_message(f"❌  Invalid position.", ephemeral=True)
        return
    lst = list(player.queue)
    removed = lst.pop(position - 1)
    player.queue = deque(lst)
    await interaction.response.send_message(f"🗑  Removed: **{removed.title}**")


@tree.command(name="clear", description="Clear the entire queue")
async def slash_clear(interaction: discord.Interaction):
    player = get_player(interaction.guild)
    player.queue.clear()
    await interaction.response.send_message("🗑  Queue cleared.")


@tree.command(name="seek", description="Seek to a position in the current track")
@app_commands.describe(position="Position in seconds or mm:ss format")
async def slash_seek(interaction: discord.Interaction, position: str):
    await interaction.response.defer(thinking=True)
    player = get_player(interaction.guild)
    if not player.current:
        await interaction.followup.send("❌  Nothing is playing.", ephemeral=True)
        return

    try:
        if ":" in position:
            parts   = position.split(":")
            seconds = int(parts[0]) * 60 + int(parts[1])
        else:
            seconds = int(position)
    except (ValueError, IndexError):
        await interaction.followup.send("❌  Invalid format. Use `90` or `1:30`.", ephemeral=True)
        return

    track      = player.current
    stream_url = track.stream_url or await refresh_stream_url(track)

    vol_opts = dict(FFMPEG_OPTS)
    vol_opts["before_options"] = f"-ss {seconds} " + vol_opts["before_options"]
    vol_opts["options"]        = f"-vn -af volume={player.volume}"

    try:
        source = await discord.FFmpegOpusAudio.from_probe(
            stream_url,
            before_options=vol_opts["before_options"],
            options=vol_opts["options"],
        )
    except Exception as e:
        await interaction.followup.send(f"❌  Seek failed: {e}", ephemeral=True)
        return

    def _after(error):
        asyncio.run_coroutine_threadsafe(play_next(interaction.guild.id), bot.loop)

    player.voice_client.stop()
    player.voice_client.play(source, after=_after)
    await interaction.followup.send(f"⏩  Seeked to `{_fmt_dur(seconds)}`.")


@tree.command(name="ytinfo", description="Preview a video's info without playing it")
@app_commands.describe(url="The URL to look up")
async def slash_ytinfo(interaction: discord.Interaction, url: str):
    await interaction.response.defer(thinking=True)
    try:
        tracks = await resolve_input(url)
    except Exception as e:
        await interaction.followup.send(f"❌  Error: {e}", ephemeral=True)
        return

    if not tracks:
        await interaction.followup.send("❌  Could not fetch info.", ephemeral=True)
        return

    t = tracks[0]
    embed = discord.Embed(title=t.title, url=t.webpage_url, color=0xFF0000)
    embed.add_field(name="Channel",  value=t.uploader,          inline=True)
    embed.add_field(name="Duration", value=t.format_duration(), inline=True)
    if t.thumbnail:
        embed.set_image(url=t.thumbnail)
    embed.set_footer(text="Use /play to add this to the queue.")
    await interaction.followup.send(embed=embed)


@tree.command(name="lyrics", description="Fetch and display lyrics for a song")
@app_commands.describe(query="Song name (leave blank for current track)")
async def slash_lyrics(interaction: discord.Interaction, query: str = ""):
    await interaction.response.defer(thinking=True)
    player = get_player(interaction.guild)

    if not query:
        if player.current:
            query = player.current.title
        else:
            await interaction.followup.send("❌  Provide a song name or start playing.", ephemeral=True)
            return

    if not LYRICS_ENABLED:
        await interaction.followup.send("❌  Lyrics not available.", ephemeral=True)
        return

    def _fetch():
        try:
            return syncedlyrics.search(query, plain_only=True, enhanced=False)
        except Exception:
            return None

    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _fetch)

    if not result:
        await interaction.followup.send(f"❌  No lyrics found for **{query}**.", ephemeral=True)
        return

    clean  = re.sub(r"\[\d+:\d+\.\d+\]\s*", "", result).strip()
    chunks = textwrap.wrap(clean, width=3900, break_long_words=False, replace_whitespace=False)
    first  = chunks[0] if chunks else clean

    embed = discord.Embed(title=f"🎵  Lyrics — {query}", description=first, color=0x1DB954)
    if len(chunks) > 1:
        embed.set_footer(text=f"Showing first portion")
    await interaction.followup.send(embed=embed)


@tree.command(name="ping", description="Check the bot's latency")
async def slash_ping(interaction: discord.Interaction):
    latency = round(bot.latency * 1000)
    await interaction.response.send_message(f"🏓  Pong! Latency: **{latency}ms**")


@tree.command(name="help", description="Show all available commands")
async def slash_help(interaction: discord.Interaction):
    p = PREFIX
    embed = discord.Embed(
        title="🎵  Sonyx Music Bot — Help",
        description="A full-featured music bot. Stream from YouTube, SoundCloud, Spotify & Apple Music.",
        color=0x1DB954,
    )
    embed.add_field(
        name="▶️  Playback",
        value=(
            f"`{p}play` `/play` — Play or queue a song\n"
            f"`{p}pause` `/pause` — Pause\n"
            f"`{p}resume` `/resume` — Resume\n"
            f"`{p}skip` `/skip` — Skip\n"
            f"`{p}stop` `/stop` — Stop & disconnect\n"
            f"`{p}seek` `/seek` — Seek to position\n"
            f"`{p}volume` `/volume` — Set volume"
        ),
        inline=False,
    )
    embed.add_field(
        name="📋  Queue",
        value=(
            f"`{p}queue` `/queue` — Show queue\n"
            f"`{p}nowplaying` `/nowplaying` — Current track\n"
            f"`{p}loop` `/loop` — Cycle loop mode\n"
            f"`{p}shuffle` `/shuffle` — Shuffle\n"
            f"`{p}remove` `/remove` — Remove track\n"
            f"`{p}clear` `/clear` — Clear queue"
        ),
        inline=False,
    )
    embed.add_field(
        name="🔍  Info",
        value=f"`{p}ytinfo` `/ytinfo` — Preview\n`{p}lyrics` `/lyrics` — Lyrics",
        inline=False,
    )
    embed.set_footer(text="Supported: YouTube • SoundCloud • Spotify • Apple Music")
    await interaction.response.send_message(embed=embed)


# ══════════════════════════════════════════════════════════════════════════════
#  Error handling
# ══════════════════════════════════════════════════════════════════════════════

@bot.event
async def on_command_error(ctx: commands.Context, error):
    if isinstance(error, commands.CommandNotFound):
        return
    if isinstance(error, commands.CommandOnCooldown):
        return   # handled per-command
    if isinstance(error, commands.CommandInvokeError):
        original = error.original
        if isinstance(original, discord.Forbidden):
            return
        print(f"[sonyx] Command invoke error in {ctx.command}: {original}")
        traceback.print_exc()
        return
    if isinstance(error, commands.MissingRequiredArgument):
        return
    raise error


# ══════════════════════════════════════════════════════════════════════════════
#  Bot events
# ══════════════════════════════════════════════════════════════════════════════

@bot.event
async def on_ready():
    try:
        synced = await tree.sync()
        print(f"[sonyx] Slash commands synced: {len(synced)} command(s)")
    except Exception as e:
        print(f"[sonyx] Failed to sync slash commands: {e}")

    inactivity_watchdog.start()
    print(f"[sonyx] Logged in as {bot.user} (ID: {bot.user.id})")
    print(f"[sonyx] Prefix: '{PREFIX}'")
    print(f"[sonyx] Spotify: {'enabled' if SPOTIFY_ENABLED else 'disabled'}")
    print(f"[sonyx] Lyrics:  {'enabled' if LYRICS_ENABLED else 'disabled'}")
    print("-" * 50)


@bot.event
async def on_voice_state_update(member: discord.Member, before, after):
    """Auto-disconnect if everyone leaves the VC."""
    if member.bot:
        return
    guild  = member.guild
    player = _players.get(guild.id)
    if not player or not player.is_connected():
        return

    vc = player.voice_client
    if vc and vc.channel:
        non_bots = [m for m in vc.channel.members if not m.bot]
        if not non_bots:
            player.last_activity = time.monotonic() - INACTIVITY_TIMEOUT  # trigger watchdog immediately


# ══════════════════════════════════════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
