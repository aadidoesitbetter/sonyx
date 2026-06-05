import { config } from "../config";
import { logger } from "./logger";

export async function fetchLyrics(
  artist: string,
  title: string
): Promise<string | null> {
  const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, "").trim();

  try {
    const res = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(cleanTitle)}`
    );
    if (res.ok) {
      const data = (await res.json()) as { lyrics?: string };
      if (data.lyrics) return data.lyrics;
    }
  } catch (err) {
    logger.warn({ err }, "lyrics.ovh failed");
  }

  if (config.genius.token) {
    try {
      const searchRes = await fetch(
        `https://api.genius.com/search?q=${encodeURIComponent(`${artist} ${cleanTitle}`)}`,
        { headers: { Authorization: `Bearer ${config.genius.token}` } }
      );
      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as {
          response: { hits: { result: { url: string } }[] };
        };
        const url = searchData.response.hits[0]?.result?.url;
        if (url) {
          const pageRes = await fetch(url);
          const html = await pageRes.text();
          const match = html.match(
            /<div[^>]*class="[^"]*lyrics[^"]*"[^>]*>([\s\S]*?)<\/div>/
          );
          if (match) {
            return match[1]
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .trim();
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "Genius API failed");
    }
  }

  return null;
}
