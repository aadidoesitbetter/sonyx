export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function parseTimestamp(input: string): number | null {
  if (/^\d+$/.test(input)) return parseInt(input, 10);
  const parts = input.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export function createProgressBar(elapsed: number, total: number, size = 12): string {
  if (!total) return "──────────── 0:00 / 0:00";
  const progress = Math.min(elapsed / total, 1);
  const filled = Math.round(progress * size);
  const bar = "─".repeat(filled) + "●" + "─".repeat(Math.max(0, size - filled - 1));
  return `${bar} ${formatDuration(elapsed)} / ${formatDuration(total)}`;
}

export function isUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function detectSource(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YouTube";
  if (lower.includes("music.youtube")) return "YouTube Music";
  if (lower.includes("spotify.com")) return "Spotify";
  if (lower.includes("soundcloud.com")) return "SoundCloud";
  if (lower.includes("music.apple.com")) return "Apple Music";
  if (lower.includes("deezer.com")) return "Deezer";
  if (lower.includes("tidal.com")) return "Tidal";
  if (lower.includes("bandcamp.com")) return "Bandcamp";
  if (lower.includes("twitch.tv")) return "Twitch";
  if (lower.includes("vimeo.com")) return "Vimeo";
  if (lower.includes("mixcloud.com")) return "Mixcloud";
  if (lower.includes("reddit.com")) return "Reddit";
  if (lower.includes("tiktok.com")) return "TikTok";
  if (lower.includes("discord.com") || lower.includes("discordapp.com")) return "Attachment";
  return "HTTP";
}

export function buildSearchQuery(source: string, query: string): string {
  const encoded = encodeURIComponent(query);
  switch (source) {
    case "youtubemusic":
      return `ytmsearch:${query}`;
    case "spotify":
      return `spsearch:${query}`;
    case "soundcloud":
      return `scsearch:${query}`;
    case "deezer":
      return `dzsearch:${query}`;
    default:
      return `ytsearch:${query}`;
  }
}
