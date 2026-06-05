import dotenv from "dotenv";

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    clientSecret: optional("DISCORD_CLIENT_SECRET", ""),
  },
  database: {
    url: required("DATABASE_URL"),
  },
  lavalink: {
    host: optional("LAVALINK_HOST", "localhost"),
    port: parseInt(optional("LAVALINK_PORT", "2333"), 10),
    password: optional("LAVALINK_PASSWORD", "youshallnotpass"),
  },
  genius: {
    token: optional("GENIUS_API_TOKEN", ""),
  },
  dashboard: {
    url: optional("DASHBOARD_URL", "http://localhost:3000"),
  },
  links: {
    support: optional("SUPPORT_SERVER_URL", "https://discord.gg/sonyx"),
    vote: optional("VOTE_URL", "https://top.gg/bot/sonyx"),
    website: optional("WEBSITE_URL", "https://sonyx.xyz"),
  },
  logging: {
    level: optional("LOG_LEVEL", "info"),
  },
  brand: {
    name: "Sonyx",
    prefix: ",",
    color: 0x7b2fbe,
    errorColor: 0xed4245,
    successColor: 0x57f287,
    footer: "Sonyx • sonyx.xyz",
    status: "🎵 ,help | sonyx",
    version: "1.0.0",
  },
} as const;

export const DEFAULT_DJ_LOCKED_COMMANDS = [
  "stop",
  "clear",
  "move",
  "shuffle",
  "volume",
  "loop",
  "leavecleanup",
  "removedupes",
  "skipto",
  "setsource",
  "defaultvolume",
];

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a"];

export const SEARCH_SOURCES = [
  "youtube",
  "youtubemusic",
  "spotify",
  "soundcloud",
  "deezer",
] as const;

export type SearchSource = (typeof SEARCH_SOURCES)[number];
