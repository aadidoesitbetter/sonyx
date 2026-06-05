import http from "http";
import { playerManager } from "../utils/player";
import { getOrCreateGuild, updateGuild, prisma } from "../utils/db";
import { logger } from "../utils/logger";

const API_PORT = parseInt(process.env.API_PORT ?? "4000", 10);
const API_SECRET = process.env.API_SECRET ?? "sonyx-internal";

export function startApiServer(): void {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${API_SECRET}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${API_PORT}`);

    try {
      if (url.pathname === "/health") {
        json(res, 200, { ok: true });
        return;
      }

      const guildMatch = url.pathname.match(/^\/guilds\/(\d+)$/);
      if (guildMatch && req.method === "GET") {
        const guildId = guildMatch[1];
        const settings = await getOrCreateGuild(guildId);
        const player = playerManager.get(guildId);
        json(res, 200, {
          settings,
          player: player
            ? {
                current: player.current,
                queue: player.queue.map((t) => ({
                  title: t.title,
                  artist: t.artist,
                  url: t.url,
                  duration: t.duration,
                  requester: t.requester.username,
                })),
                volume: player.volume,
                paused: player.paused,
                loopMode: player.loopMode,
              }
            : null,
        });
        return;
      }

      const settingsMatch = url.pathname.match(/^\/guilds\/(\d+)\/settings$/);
      if (settingsMatch && req.method === "PATCH") {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const updated = await updateGuild(settingsMatch[1], data);
        json(res, 200, updated);
        return;
      }

      const playerMatch = url.pathname.match(/^\/guilds\/(\d+)\/player\/(\w+)$/);
      if (playerMatch && req.method === "POST") {
        const [, guildId, action] = playerMatch;
        const player = playerManager.get(guildId);
        if (!player) {
          json(res, 404, { error: "No active player" });
          return;
        }
        switch (action) {
          case "pause":
            await player.pause();
            break;
          case "resume":
            await player.resume();
            break;
          case "skip":
            await player.skip();
            break;
          case "stop":
            await player.stop();
            break;
          default:
            json(res, 400, { error: "Unknown action" });
            return;
        }
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/users/me/profile" && req.method === "GET") {
        const userId = url.searchParams.get("userId");
        if (!userId) {
          json(res, 400, { error: "userId required" });
          return;
        }
        const user = await prisma.user.findUnique({ where: { userId } });
        const playlists = await prisma.playlist.findMany({
          where: { ownerId: userId },
          include: { _count: { select: { songs: true } } },
        });
        const history = await prisma.listeningHistory.findMany({
          where: { userId },
          orderBy: { playedAt: "desc" },
          take: 50,
        });
        json(res, 200, { user, playlists, history });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      logger.error({ err }, "API error");
      json(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(API_PORT, () => {
    logger.info(`API server listening on port ${API_PORT}`);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
