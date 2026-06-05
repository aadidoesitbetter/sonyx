# Sonyx

A fully featured, completely free Discord music bot built with TypeScript, discord.js, Lavalink, and a Next.js web dashboard.

## Features

- **Multi-source playback** — YouTube, YouTube Music, Spotify, Apple Music, SoundCloud, Deezer, Tidal, Bandcamp, Twitch, Vimeo, Mixcloud, Reddit, TikTok, and direct file uploads
- **Core playback** — play, pause, skip, seek, loop, volume, autoplay, 24/7 mode, lyrics, and more
- **Queue management** — shuffle, move, remove, search, vote skip, history
- **Audio filters** — bassboost, nightcore, 8D, karaoke, pitch, speed, rate, and more
- **Custom playlists** — per-user playlists, favourites, Spotify integration
- **DJ system** — role-based command locking
- **Server settings** — prefix, channels, search source, vote skip, setup wizard
- **Now Playing UI** — rich embeds with interactive buttons and auto-updating progress
- **Song request channel** — type songs without a prefix
- **Music cards** — generate stylized PNG cards and lyric frames
- **Web dashboard** — Discord OAuth login, server control panel, web player
- **100% free** — no paywalls, no tiers, no restrictions

## Requirements

- **Node.js** v20+
- **Java** 17+ (for Lavalink)
- **PostgreSQL** database (Supabase recommended)
- **Discord Bot** application ([Discord Developer Portal](https://discord.com/developers/applications))

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/yourusername/sonyx.git
cd sonyx
npm install
cd dashboard && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in your `.env`:

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application client ID |
| `DISCORD_CLIENT_SECRET` | Application client secret (for dashboard OAuth) |
| `DATABASE_URL` | PostgreSQL connection string (Supabase) |
| `LAVALINK_HOST` | Lavalink host (default: `localhost`) |
| `LAVALINK_PORT` | Lavalink port (default: `2333`) |
| `LAVALINK_PASSWORD` | Lavalink password |
| `GENIUS_API_TOKEN` | Optional Genius API token for lyrics |
| `DASHBOARD_URL` | Dashboard URL (default: `http://localhost:3000`) |
| `NEXTAUTH_SECRET` | Random secret for NextAuth |
| `NEXTAUTH_URL` | Same as dashboard URL |
| `API_SECRET` | Internal API secret (default: `sonyx-internal`) |

### 3. Set up the database

```bash
npx prisma generate
npx prisma db push
```

### 4. Start Lavalink

Download [Lavalink 4](https://github.com/lavalink-devs/Lavalink/releases) and place `application.yml` from this repo in the Lavalink directory.

**Recommended plugins** (configured in `application.yml`):
- **LavaSrc** — Spotify, Apple Music, Deezer, Tidal
- **Lyrics plugin** — enhanced lyrics support

For Spotify support, set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` environment variables when starting Lavalink.

```bash
java -jar Lavalink.jar
```

### 5. Start the bot

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

### 6. Start the dashboard

```bash
cd dashboard
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Docker

Run the full stack with Docker Compose:

```bash
docker-compose up -d
```

This starts Lavalink, the bot, and the dashboard.

## Project Structure

```
sonyx/
├── src/
│   ├── index.ts          # Bot entry point
│   ├── config.ts         # Environment config
│   ├── commands/         # Command modules
│   ├── events/           # Event handlers
│   ├── utils/            # Helpers (player, embeds, db, etc.)
│   └── api/              # Internal HTTP API for dashboard
├── dashboard/            # Next.js web dashboard
├── prisma/               # Database schema
├── application.yml       # Lavalink config
└── docker-compose.yml
```

## Commands

Default prefix: `,` (configurable per server)

All commands work as both prefix (`,play`) and slash (`/play`) commands.

| Category | Examples |
|----------|----------|
| Music | `,play`, `,pause`, `,skip`, `,volume`, `,nowplaying`, `,lyrics` |
| Queue | `,queue`, `,shuffle`, `,search`, `,history`, `,voteskip` |
| Filters | `,bassboost`, `,nightcore`, `,8d`, `,pitch`, `,reset` |
| Playlists | `,playlist create`, `,playlist load`, `,favourites` |
| Settings | `,setup`, `,settings`, `,prefix`, `,setsource` |
| DJ | `,dj role add`, `,dj toggle`, `,dj list` |
| Info | `,help`, `,about`, `,ping`, `,profile`, `,dashboard` |

Use `,help [command]` for detailed help on any command.

## Dashboard

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/dashboard` | Server list (requires Manage Server) |
| `/dashboard/[id]` | Server control panel |
| `/profile` | User profile, history, playlists |
| `/player` | Web-based music player |

## Lavalink Plugins

The included `application.yml` configures:
- High-quality Opus encoding
- LavaSrc for Spotify, Apple Music, Deezer, Tidal
- Source allowlist: youtube, youtubemusic, soundcloud, bandcamp, twitch, vimeo, http

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License — see LICENSE file.

---

**Sonyx** • [sonyx.xyz](https://sonyx.xyz)
