"""
ytaudio_bot.py  —  Discord bot that downloads YouTube audio and sends it back.

Usage (prefix commands):
    !ytaudio <url>          Download audio
    !ytaudio help           Show help

Usage (slash commands):
    /ytaudio url:<url>      Download audio

Requirements:
    pip install discord.py yt-dlp pomice
    Also needs ffmpeg installed on the system:
      macOS:   brew install ffmpeg
      Linux:   sudo apt install ffmpeg
      Windows: https://ffmpeg.org/download.html
"""

import asyncio
import os
import re
import traceback
import uuid
import time
from pathlib import Path

import discord
import yt_dlp
import mutagen
import pomice
from discord import app_commands
from discord.ext import commands

# ── Load config ───────────────────────────────────────────────────────────────
try:
    from config import (
        ALLOWED_CHANNELS,
        AUDIO_FORMAT,
        AUDIO_QUALITY,
        DELETE_AFTER_SEND,
        DISCORD_TOKEN,
        MAX_DURATION,
        PREFIX,
        LAVALINK_HOST,
        LAVALINK_PORT,
        LAVALINK_PASSWORD,
        LAVALINK_SECURE,
        LAVALINK_ID,
        SPOTIFY_CLIENT_ID,
        SPOTIFY_CLIENT_SECRET,
        PLAYER_VOLUME,
        DISCONNECT_AFTER,
    )
except ImportError:
    raise SystemExit("❌  config.py not found. Copy config.py next to this file and fill in your values.")

# ── Sanity-check token ────────────────────────────────────────────────────────
if not DISCORD_TOKEN or DISCORD_TOKEN == "YOUR_DISCORD_BOT_TOKEN_HERE":
    raise SystemExit("❌  DISCORD_TOKEN is not set! Please configure it in your environment variables or Railway Dashboard.")

# ── Discord setup ─────────────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True          # Required to read message text
intents.voice_states = True             # Required for Pomice/Lavalink

class SonyxBot(commands.Bot):
    def __init__(self):
        super().__init__(
            command_prefix=PREFIX,
            intents=intents,
            help_command=None
        )
        self.pomice = pomice.NodePool()

    async def setup_hook(self):
        # Connect to Lavalink node
        try:
            await self.pomice.create_node(
                bot=self,
                host=LAVALINK_HOST,
                port=LAVALINK_PORT,
                password=LAVALINK_PASSWORD,
                identifier=LAVALINK_ID,
                secure=LAVALINK_SECURE,
                spotify_client_id=SPOTIFY_CLIENT_ID,
                spotify_client_secret=SPOTIFY_CLIENT_SECRET,
            )
            print(f"[sonyx] Lavalink node connected: {LAVALINK_HOST}:{LAVALINK_PORT}")
        except Exception as e:
            print(f"[sonyx] WARNING: Lavalink node failed to connect: {e}")
            print("[sonyx] Voice player will be unavailable. Download commands still work.")

bot = SonyxBot()
tree = bot.tree                         # Slash-command tree

# ── Global State ──────────────────────────────────────────────────────────────
_guild_text_channels: dict[int, discord.TextChannel] = {}
_cooldowns: dict[int, float] = {}
COOLDOWN_SECONDS = 15

# ── Helpers ───────────────────────────────────────────────────────────────────
YT_URL_PATTERN = re.compile(
    r"(https?://)?(www\.)?"
    r"(youtube\.com/(watch\?v=|shorts/|embed/|v/)|youtu\.be/)"
    r"[\w\-]{11}"
)

DOWNLOAD_DIR = Path("downloads")
DOWNLOAD_DIR.mkdir(exist_ok=True)

DISCORD_MAX_BYTES = 25 * 1024 * 1024   # 25 MB free-tier limit

# ── Dynamic cookies file creation from environment variable ───────────────────
def setup_cookies():
    cookies_env = os.environ.get("YOUTUBE_COOKIES") or os.environ.get("YT_COOKIES")
    cookies_path = Path("cookies.txt")
    if cookies_env:
        print(f"[ytaudio] Found YOUTUBE_COOKIES environment variable (length: {len(cookies_env)} characters)")
        try:
            lines = []
            for line in cookies_env.strip().splitlines():
                trimmed = line.strip()
                if not trimmed:
                    continue
                if trimmed.startswith("#"):
                    lines.append(trimmed)
                    continue
                parts = trimmed.split(None, 6)
                if len(parts) == 7:
                    lines.append("\t".join(parts))
                else:
                    lines.append(trimmed)
            
            header = "# Netscape HTTP Cookie File"
            if not any(l.startswith(header) for l in lines[:3]):
                lines.insert(0, header)
                
            cookies_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            print("[ytaudio] Successfully wrote cookies.txt from environment variable!")
        except Exception as e:
            print(f"[ytaudio] Error writing cookies.txt from environment variable: {e}")
    else:
        if cookies_path.exists():
            print(f"[ytaudio] Using existing local cookies.txt (size: {cookies_path.stat().st_size} bytes)")
        else:
            print("[ytaudio] Warning: YOUTUBE_COOKIES or YT_COOKIES environment variable not found on startup.")

setup_cookies()

def is_valid_yt_url(url: str) -> bool:
    return bool(YT_URL_PATTERN.search(url))

def extract_video_id(url: str) -> str | None:
    """Extract 11-character YouTube video ID from URL."""
    patterns = [
        r"v=([\w\-]{11})",
        r"shorts/([\w\-]{11})",
        r"youtu\.be/([\w\-]{11})",
        r"embed/([\w\-]{11})",
        r"v/([\w\-]{11})"
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None

def fetch_youtube_metadata(url: str) -> dict:
    """Fetch video title, uploader, and thumbnail from YouTube's official oEmbed API."""
    import json
    import urllib.request
    import urllib.parse
    import urllib.error
    
    try:
        oembed_url = f"https://www.youtube.com/oembed?url={urllib.parse.quote(url)}&format=json"
        req = urllib.request.Request(
            oembed_url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            
        return {
            "title": data.get("title"),
            "uploader": data.get("author_name") or "YouTube",
            "thumbnail": data.get("thumbnail_url")
        }
    except Exception as e:
        print(f"[ytaudio] oEmbed metadata fetch failed: {e}")
        return {}

def probe_duration_with_mutagen(file_path: Path) -> int:
    """Extract audio duration in seconds using mutagen."""
    try:
        audio = mutagen.File(file_path)
        if audio and audio.info and hasattr(audio.info, 'length'):
            return int(audio.info.length)
    except Exception as e:
        print(f"[ytaudio] mutagen failed to get duration: {e}")
    return 0

_cobalt_cache = {"time": 0, "instances": []}
def get_cobalt_instances():
    import json
    import urllib.request
    now = time.time()
    if now - _cobalt_cache["time"] < 3600 and _cobalt_cache["instances"]:
        return _cobalt_cache["instances"]
    try:
        req = urllib.request.Request("https://instances.cobalt.best/api/instances.json", headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode('utf-8'))
            live_instances = []
            for inst in data:
                if inst.get("api") and inst.get("score", 0) >= 90 and inst.get("trust", 0) >= 0.8:
                    live_instances.append(inst)
            live_instances.sort(key=lambda x: x.get("latency", 9999))
            instances = [x["url"].rstrip('/') for x in live_instances]
            if instances:
                _cobalt_cache["time"] = now
                _cobalt_cache["instances"] = instances
                return instances
    except Exception as e:
        print(f"[ytaudio] Failed to fetch live Cobalt instances: {e}")
    
    if _cobalt_cache["instances"]:
        return _cobalt_cache["instances"]
    return [
        "https://cobaltapi.kittycat.boo",
        "https://api.cobalt.liubquanti.click",
        "https://api.cobalt.blackcat.sweeux.org",
        "https://cobaltapi.cjs.nz",
    ]


def download_via_cobalt(url: str, job_dir: Path, audio_format: str) -> dict:
    """Download audio via Cobalt API instances."""
    import json
    import urllib.request
    import urllib.error

    custom_instance = os.environ.get("COBALT_API_URL")
    instances = []
    if custom_instance:
        instances.append(custom_instance.rstrip('/'))

    default_instances = get_cobalt_instances()
    for inst in default_instances:
        if inst not in instances:
            instances.append(inst)

    # 1. Fetch metadata via oEmbed first (never blocked)
    meta = fetch_youtube_metadata(url)
    video_id = extract_video_id(url)
    
    title = meta.get("title")
    uploader = meta.get("uploader", "YouTube (via Cobalt)")
    thumbnail_url = meta.get("thumbnail") or (f"https://img.youtube.com/vi/{video_id}/hqdefault.jpg" if video_id else "")

    last_err = None
    for instance in instances:
        try:
            print(f"[ytaudio] Trying Cobalt instance: {instance}")
            payload = {
                "url": url,
                "downloadMode": "audio",
                "audioFormat": audio_format,
                "audioBitrate": "320"
            }
            api_url = f"{instance}/"
            
            req = urllib.request.Request(
                api_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                method='POST'
            )

            with urllib.request.urlopen(req, timeout=20) as response:
                res_data = json.loads(response.read().decode('utf-8'))

            status = res_data.get("status")
            if status not in ("tunnel", "redirect"):
                error_msg = res_data.get("error", {}).get("code") or res_data.get("error") or "Unknown status"
                print(f"[ytaudio] Cobalt instance {instance} returned status={status}, error={error_msg}")
                raise Exception(f"Cobalt error: {error_msg}")

            download_url = res_data.get("url")
            if not download_url:
                raise Exception("No download URL returned by Cobalt API.")

            filename = res_data.get("filename") or f"audio.{audio_format}"
            safe_filename = "".join(c for c in filename if c.isalnum() or c in "._- ")
            if not safe_filename:
                safe_filename = f"audio.{audio_format}"

            out_path = job_dir / safe_filename
            print(f"[ytaudio] Downloading file from Cobalt: {download_url} -> {out_path}")

            req_get = urllib.request.Request(
                download_url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            )
            with urllib.request.urlopen(req_get, timeout=60) as download_res:
                with open(out_path, 'wb') as out_file:
                    while True:
                        chunk = download_res.read(64 * 1024)
                        if not chunk:
                            break
                        out_file.write(chunk)

            if not out_path.exists() or out_path.stat().st_size == 0:
                if out_path.exists():
                    out_path.unlink(missing_ok=True)
                raise Exception("Downloaded file is empty (0 bytes)")

            # 2. Get exact duration from the downloaded file using mutagen
            duration = probe_duration_with_mutagen(out_path)

            if not title:
                title = filename
                if title.lower().endswith(f".{audio_format}"):
                    title = title[:-len(audio_format)-1]
                elif '.' in title:
                    title = title.rsplit('.', 1)[0]

            return {
                "title": title,
                "uploader": uploader,
                "duration": duration,
                "webpage_url": url,
                "thumbnail": thumbnail_url,
            }
        except urllib.error.HTTPError as e:
            err_code = e.code
            err_reason = e.reason
            try:
                err_body = e.read().decode('utf-8')
                res_data = json.loads(err_body)
                error_msg = res_data.get("error", {}).get("code") or res_data.get("error") or f"HTTP {err_code} {err_reason}"
                print(f"[ytaudio] Cobalt instance {instance} failed: {error_msg}")
                last_err = Exception(f"Cobalt error: {error_msg}")
            except Exception:
                print(f"[ytaudio] Cobalt instance {instance} failed: HTTP {err_code} {err_reason}")
                last_err = Exception(f"Cobalt HTTP Error {err_code}: {err_reason}")
            continue
        except Exception as e:
            print(f"[ytaudio] Cobalt instance {instance} failed: {e}")
            last_err = e
            continue

    if last_err:
        raise last_err
    else:
        raise Exception("All Cobalt API instances failed.")

def download_via_ytdlp(url: str, job_dir: Path) -> dict:
    """Fallback audio download via yt-dlp."""
    print(f"[ytaudio] Trying yt-dlp fallback download...")
    
    # We want to extract audio only, in the requested format and quality
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': str(job_dir / '%(title)s.%(ext)s'),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': AUDIO_FORMAT,
            'preferredquality': AUDIO_QUALITY,
        }],
        'quiet': True,
        'no_warnings': True,
    }
    
    cookies_path = Path("cookies.txt")
    if cookies_path.exists():
        ydl_opts['cookiefile'] = str(cookies_path)
        print("[ytaudio] Using cookies.txt for yt-dlp fallback download")

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info_dict = ydl.extract_info(url, download=True)
        
    duration = int(info_dict.get("duration", 0))
    
    return {
        "title": info_dict.get("title"),
        "uploader": info_dict.get("uploader"),
        "duration": duration,
        "webpage_url": info_dict.get("webpage_url"),
        "thumbnail": info_dict.get("thumbnail"),
    }

async def download_audio(url: str, job_dir: Path) -> dict:
    """Run Cobalt download first, falling back to yt-dlp if it fails."""
    loop = asyncio.get_running_loop()
    try:
        print("[ytaudio] Attempting primary Cobalt API download...")
        info = await loop.run_in_executor(None, lambda: download_via_cobalt(url, job_dir, AUDIO_FORMAT))
        return info
    except Exception as e:
        print(f"[ytaudio] Cobalt download failed: {e}. Attempting yt-dlp fallback...")
        info = await loop.run_in_executor(None, lambda: download_via_ytdlp(url, job_dir))
        return info

def find_output_file(job_dir: Path) -> Path | None:
    """Return the first audio file found in job_dir."""
    for ext in (AUDIO_FORMAT, "m4a", "mp3", "opus", "wav", "flac", "webm", "ogg"):
        files = list(job_dir.glob(f"*.{ext}"))
        if files:
            return files[0]
    # Fallback — grab whatever is there
    all_files = list(job_dir.iterdir())
    return all_files[0] if all_files else None

def format_duration(seconds: int) -> str:
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s" if h else f"{m}m {s}s"

def build_embed(info: dict, file_size_bytes: int) -> discord.Embed:
    title = info.get("title", "Unknown Title")
    uploader = info.get("uploader") or info.get("channel", "Unknown")
    duration = info.get("duration", 0)
    url = info.get("webpage_url", "")
    thumbnail = info.get("thumbnail", "")

    embed = discord.Embed(
        title=f"🎵  {title}",
        url=url,
        color=0xFF0000,
    )
    embed.add_field(name="Channel", value=uploader, inline=True)
    embed.add_field(name="Duration", value=format_duration(duration), inline=True)
    embed.add_field(name="Format", value=AUDIO_FORMAT.upper(), inline=True)
    size_mb = file_size_bytes / (1024 * 1024)
    embed.add_field(name="File size", value=f"{size_mb:.1f} MB", inline=True)
    if thumbnail:
        embed.set_thumbnail(url=thumbnail)
    embed.set_footer(text="ytaudio bot • powered by yt-dlp")
    return embed


# ── Core download-and-send logic ──────────────────────────────────────────────
async def process_request(
    ctx_or_interaction,
    url: str,
):
    """Shared logic for both prefix and slash commands."""

    is_interaction = isinstance(ctx_or_interaction, discord.Interaction)
    user_id = ctx_or_interaction.user.id if is_interaction else ctx_or_interaction.author.id

    now = time.time()
    if user_id in _cooldowns and now - _cooldowns[user_id] < COOLDOWN_SECONDS:
        wait_time = int(COOLDOWN_SECONDS - (now - _cooldowns[user_id]))
        if is_interaction:
            await ctx_or_interaction.response.send_message(f"⏳ Please wait {wait_time} seconds before downloading again.", ephemeral=True)
        else:
            await ctx_or_interaction.reply(f"⏳ Please wait {wait_time} seconds before downloading again.")
        return
    _cooldowns[user_id] = now

    async def reply(content=None, embed=None, file=None, ephemeral=False):
        if is_interaction:
            try:
                if ctx_or_interaction.response.is_done():
                    await ctx_or_interaction.followup.send(content=content, embed=embed, file=file, ephemeral=ephemeral)
                else:
                    await ctx_or_interaction.response.send_message(content=content, embed=embed, file=file, ephemeral=ephemeral)
            except discord.Forbidden as e:
                print(f"[sonyx] Discord permission error: {e}")
                # If interaction fails (e.g. lacks Embed Links)
                if embed:
                    plain_text = content or ""
                    if not plain_text and hasattr(embed, 'title'):
                        plain_text = f"🎵  **{embed.title}**"
                    try:
                        if ctx_or_interaction.response.is_done():
                            await ctx_or_interaction.followup.send(content=plain_text, file=file, ephemeral=ephemeral)
                        else:
                            await ctx_or_interaction.response.send_message(content=plain_text, file=file, ephemeral=ephemeral)
                    except Exception as inner_e:
                        print(f"[sonyx] Discord permission error (inner fallback): {inner_e}")
                        pass
        else:
            try:
                await ctx_or_interaction.reply(content=content, embed=embed, file=file)
            except discord.Forbidden as e:
                print(f"[sonyx] Discord permission error: {e}")
                # Try sending without reply reference (Read Message History might be missing)
                try:
                    await ctx_or_interaction.send(content=content, embed=embed, file=file)
                except discord.Forbidden as e2:
                    print(f"[sonyx] Discord permission error (send fallback): {e2}")
                    # Try sending without embed (Embed Links might be missing)
                    if embed:
                        plain_text = content or ""
                        if not plain_text and hasattr(embed, 'title'):
                            plain_text = f"🎵  **{embed.title}**"
                        try:
                            await ctx_or_interaction.send(content=plain_text, file=file)
                        except Exception as e3:
                            print(f"[sonyx] Discord permission error (no embed fallback): {e3}")
                            pass

    # ── Channel guard ──────────────────────────────────────────────────────
    if ALLOWED_CHANNELS:
        channel_id = (
            ctx_or_interaction.channel_id if is_interaction else ctx_or_interaction.channel.id
        )
        if channel_id not in ALLOWED_CHANNELS:
            await reply("❌  This bot isn't allowed in this channel.", ephemeral=True)
            return

    # ── URL validation ─────────────────────────────────────────────────────
    if not is_valid_yt_url(url):
        await reply("❌  That doesn't look like a valid YouTube URL. Please provide a standard `youtube.com` or `youtu.be` link.", ephemeral=True)
        return

    # ── Acknowledge request ────────────────────────────────────────────────
    if is_interaction:
        await ctx_or_interaction.response.defer(thinking=True)
    else:
        await ctx_or_interaction.message.add_reaction("⏳")

    # ── Create a unique job directory ──────────────────────────────────────
    job_id = uuid.uuid4().hex[:8]
    job_dir = DOWNLOAD_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    audio_file: Path | None = None

    try:
        # ── Download ───────────────────────────────────────────────────────
        info = await download_audio(url, job_dir)
        audio_file = find_output_file(job_dir)

        if audio_file is None or not audio_file.exists() or audio_file.stat().st_size == 0:
            await reply("❌  Download succeeded but the audio file is empty (0 bytes) or couldn't be located. Check that `ffmpeg` is installed.", ephemeral=True)
            return

        # Fetch duration using mutagen if not reliably set
        duration = info.get("duration", 0)
        if not duration:
            duration = probe_duration_with_mutagen(audio_file)
            info["duration"] = duration

        if MAX_DURATION > 0 and duration > MAX_DURATION:
            await reply(
                f"❌  Video is **{format_duration(duration)}** long — the limit is **{format_duration(MAX_DURATION)}**.\n"
                f"You can raise `MAX_DURATION` in `config.py` if needed.",
                ephemeral=True,
            )
            return

        file_size = audio_file.stat().st_size

        # ── Size check ─────────────────────────────────────────────────────
        if file_size > DISCORD_MAX_BYTES:
            size_mb = file_size / (1024 * 1024)
            await reply(
                f"❌  The audio file is **{size_mb:.1f} MB**, which exceeds Discord's 25 MB upload limit.\n"
                f"Try a shorter video, or switch to a compressed format like `opus` in `config.py`.",
                ephemeral=True,
            )
            return

        # ── Send ───────────────────────────────────────────────────────────
        embed = build_embed(info, file_size)
        discord_file = discord.File(str(audio_file), filename=audio_file.name)

        if is_interaction:
            await ctx_or_interaction.followup.send(embed=embed, file=discord_file)
        else:
            await ctx_or_interaction.message.remove_reaction("⏳", bot.user)
            await ctx_or_interaction.message.add_reaction("✅")
            await ctx_or_interaction.reply(embed=embed, file=discord_file)

    except Exception as e:
        err = str(e)
        if "age restricted" in err.lower() or "youtube.login" in err.lower() or "confirm you're not a bot" in err.lower() or "sign in to confirm" in err.lower():
            msg = "❌  This video requires authentication/login (e.g. age-restricted or flagged by YouTube) and cannot be downloaded without cookies."
        elif "unavailable" in err.lower() or "private" in err.lower():
            msg = "❌  Video unavailable (private, deleted, or region-locked)."
        else:
            msg = f"❌  Error downloading video: ```{err[:400]}```"
            tb = traceback.format_exc()
            print(f"[ytaudio] Download error details:\n{tb}")
            
        await reply(msg, ephemeral=True)
        if not is_interaction:
            try:
                await ctx_or_interaction.message.remove_reaction("⏳", bot.user)
                await ctx_or_interaction.message.add_reaction("❌")
            except Exception:
                pass

    finally:
        # ── Cleanup ────────────────────────────────────────────────────────
        if DELETE_AFTER_SEND and audio_file and audio_file.exists():
            audio_file.unlink(missing_ok=True)
        # Remove job dir if empty
        try:
            if job_dir.exists():
                for f in job_dir.iterdir():
                    f.unlink(missing_ok=True)
                job_dir.rmdir()
        except Exception:
            pass


# ── Prefix command ────────────────────────────────────────────────────────────
@bot.command(name="ytaudio", aliases=["yta", "audio"])
async def ytaudio_prefix(ctx: commands.Context, *, arg: str = ""):
    """
    Download YouTube audio and send it here.
    Usage: {prefix}ytaudio <youtube_url>
    """
    arg = arg.strip()

    if not arg or arg.lower() in ("help", "--help", "-h"):
        embed = discord.Embed(
            title="🎵  ytaudio bot — Help",
            description="Download audio from any YouTube video and receive it as a file.",
            color=0xFF0000,
        )
        embed.add_field(
            name="Prefix command",
            value=f"`{PREFIX}ytaudio <url>`\n`{PREFIX}yta <url>`  (shorthand)",
            inline=False,
        )
        embed.add_field(
            name="Slash command",
            value="`/ytaudio url:<url>`",
            inline=False,
        )
        embed.add_field(
            name="Voice Commands",
            value="`/play <query/url>`, `/skip`, `/stop`, `/pause`, `/resume`, `/queue`, `/nowplaying`, `/volume`, `/leave`",
            inline=False,
        )
        embed.add_field(
            name="Limits",
            value=(
                f"• Max duration: **{format_duration(MAX_DURATION)}** (0 = no limit)\n"
                f"• Max file size: **25 MB** (Discord limit)\n"
                f"• Output format: **{AUDIO_FORMAT.upper()}** (quality {AUDIO_QUALITY})"
            ),
            inline=False,
        )
        embed.set_footer(text="Edit config.py to change prefix, format, quality, and limits.")
        await ctx.reply(embed=embed)
        return

    await process_request(ctx, arg)


# ── Slash command ─────────────────────────────────────────────────────────────
@tree.command(name="ytaudio", description="Download YouTube audio and receive it as a file")
@app_commands.describe(url="The YouTube video URL to extract audio from")
async def ytaudio_slash(interaction: discord.Interaction, url: str):
    await process_request(interaction, url.strip())

# ── Voice Commands (Pomice) ───────────────────────────────────────────────────

@tree.command(name="play", description="Play audio in your voice channel")
@app_commands.describe(query="URL (YouTube, Spotify, Apple Music, SoundCloud) or search query")
async def play(interaction: discord.Interaction, query: str):
    await interaction.response.defer()

    if not interaction.user.voice or not interaction.user.voice.channel:
        return await interaction.followup.send("❌ You must be in a voice channel to use this command.")

    channel = interaction.user.voice.channel
    player: pomice.Player = interaction.guild.voice_client

    if not player:
        try:
            player = await channel.connect(cls=pomice.Player)
            await player.set_volume(int(PLAYER_VOLUME * 100))
        except Exception as e:
            return await interaction.followup.send(f"❌ Failed to connect to voice channel: {e}")

    _guild_text_channels[interaction.guild.id] = interaction.channel

    try:
        results = await bot.pomice.get_tracks(query, ctx=interaction)
    except Exception as e:
        return await interaction.followup.send(f"❌ Error searching for tracks: {e}")

    if not results:
        return await interaction.followup.send("❌ No results found.")

    if isinstance(results, pomice.Playlist):
        for track in results.tracks:
            await player.queue.put(track)
        await interaction.followup.send(f"✅ Added playlist **{results.name}** ({len(results.tracks)} tracks) to the queue.")
    else:
        track = results[0]
        await player.queue.put(track)
        await interaction.followup.send(f"✅ Added **{track.title}** to the queue.")

    if not player.is_playing:
        await player.play(await player.queue.get())

@tree.command(name="skip", description="Skip the current track")
async def skip(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player or not player.is_playing:
        return await interaction.response.send_message("❌ Nothing is currently playing.")

    await player.stop()
    await interaction.response.send_message("⏭️ Skipped.")

@tree.command(name="stop", description="Stop playback and clear the queue")
async def stop(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player:
        return await interaction.response.send_message("❌ I am not connected to a voice channel.")

    player.queue.clear()
    await player.stop()
    await interaction.response.send_message("⏹️ Stopped and cleared the queue.")

@tree.command(name="pause", description="Pause the current track")
async def pause(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player or not player.is_playing:
        return await interaction.response.send_message("❌ Nothing is currently playing.")

    if player.is_paused:
        return await interaction.response.send_message("❌ The player is already paused.")

    await player.set_pause(True)
    await interaction.response.send_message("⏸️ Paused.")

@tree.command(name="resume", description="Resume the current track")
async def resume(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player or not player.is_paused:
        return await interaction.response.send_message("❌ The player is not paused.")

    await player.set_pause(False)
    await interaction.response.send_message("▶️ Resumed.")

@tree.command(name="queue", description="Show the current queue")
async def queue_cmd(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player or player.queue.is_empty:
        return await interaction.response.send_message("The queue is empty.")

    tracks = player.queue.get_queue()
    description = "\n".join(f"{i+1}. **{track.title}**" for i, track in enumerate(tracks[:10]))
    if len(tracks) > 10:
        description += f"\n*...and {len(tracks) - 10} more*"

    embed = discord.Embed(title="Current Queue", description=description, color=0xFF0000)
    await interaction.response.send_message(embed=embed)

@tree.command(name="nowplaying", description="Show the currently playing track")
async def nowplaying(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player or not player.current:
        return await interaction.response.send_message("❌ Nothing is currently playing.")

    track = player.current
    embed = discord.Embed(title="Now Playing", description=f"**{track.title}** by {track.author}", color=0xFF0000)
    if track.uri:
        embed.url = track.uri
    await interaction.response.send_message(embed=embed)

@tree.command(name="volume", description="Set the player volume (0-100)")
@app_commands.describe(vol="Volume percentage")
async def volume(interaction: discord.Interaction, vol: int):
    player: pomice.Player = interaction.guild.voice_client
    if not player:
        return await interaction.response.send_message("❌ I am not connected to a voice channel.")

    if not 0 <= vol <= 100:
        return await interaction.response.send_message("❌ Volume must be between 0 and 100.")

    await player.set_volume(vol)
    await interaction.response.send_message(f"🔊 Volume set to {vol}%.")

@tree.command(name="leave", description="Disconnect from the voice channel")
async def leave(interaction: discord.Interaction):
    player: pomice.Player = interaction.guild.voice_client
    if not player:
        return await interaction.response.send_message("❌ I am not connected to a voice channel.")

    await player.destroy()
    await interaction.response.send_message("👋 Disconnected.")

# ── Pomice Events ─────────────────────────────────────────────────────────────

async def on_pomice_track_end(player: pomice.Player, track: pomice.Track, reason: str):
    if not player.queue.is_empty:
        await player.play(await player.queue.get())
    else:
        # Queue empty — optionally disconnect after DISCONNECT_AFTER seconds
        await asyncio.sleep(DISCONNECT_AFTER)
        if not player.is_playing and player.is_connected:
            await player.destroy()
            if player.guild.id in _guild_text_channels:
                channel = _guild_text_channels[player.guild.id]
                try:
                    await channel.send("👋 Left the voice channel due to inactivity.")
                except Exception:
                    pass

async def on_pomice_track_stuck(player: pomice.Player, track: pomice.Track, threshold: int):
    await player.stop()
    if not player.queue.is_empty:
        await player.play(await player.queue.get())

async def on_pomice_track_exception(player: pomice.Player, track: pomice.Track, error: str):
    print(f"[sonyx] Track exception: {error}")
    if not player.queue.is_empty:
        await player.play(await player.queue.get())

bot.add_listener(on_pomice_track_end, "on_pomice_track_end")
bot.add_listener(on_pomice_track_stuck, "on_pomice_track_stuck")
bot.add_listener(on_pomice_track_exception, "on_pomice_track_exception")


# ── Bot events ────────────────────────────────────────────────────────────────
@bot.event
async def on_ready():
    # Sync slash commands globally (may take up to 1 hour to appear everywhere)
    try:
        synced = await tree.sync()
        print(f"[ytaudio] Slash commands synced: {len(synced)} command(s)")
    except Exception as e:
        print(f"[ytaudio] Failed to sync slash commands: {e}")

    print(f"[ytaudio] Logged in as {bot.user} (ID: {bot.user.id})")
    print(f"[ytaudio] Prefix: '{PREFIX}'  |  Format: {AUDIO_FORMAT.upper()}  |  Quality: {AUDIO_QUALITY}")
    print(f"[ytaudio] Max duration: {format_duration(MAX_DURATION) if MAX_DURATION else 'unlimited'}")
    print(f"[ytaudio] Using Cobalt API for audio extraction.")
    print("-" * 50)


@bot.event
async def on_command_error(ctx: commands.Context, error):
    if isinstance(error, commands.CommandNotFound):
        return  # Silently ignore unknown commands
    
    if isinstance(error, commands.CommandInvokeError):
        if isinstance(error.original, discord.Forbidden):
            return  # Silently ignore permission errors during command execution

    if isinstance(error, commands.MissingRequiredArgument):
        msg = f"❌  Missing URL. Usage: `{PREFIX}ytaudio <url>`"
        try:
            await ctx.reply(msg)
        except discord.Forbidden:
            try:
                await ctx.send(msg)
            except Exception:
                pass
        return
    raise error


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
