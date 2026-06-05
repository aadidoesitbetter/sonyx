import { PrismaClient, Guild, User } from "@prisma/client";
import { DEFAULT_DJ_LOCKED_COMMANDS } from "../config";
import { logger } from "./logger";

export const prisma = new PrismaClient();

export async function getOrCreateGuild(guildId: string): Promise<Guild> {
  return prisma.guild.upsert({
    where: { guildId },
    update: {},
    create: {
      guildId,
      djLockedCommands: [...DEFAULT_DJ_LOCKED_COMMANDS],
    },
  });
}

export async function getOrCreateUser(userId: string): Promise<User> {
  return prisma.user.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

export async function updateGuild(
  guildId: string,
  data: Partial<Omit<Guild, "guildId" | "createdAt" | "updatedAt">>
): Promise<Guild> {
  return prisma.guild.update({
    where: { guildId },
    data,
  });
}

export async function recordListening(
  userId: string,
  guildId: string,
  track: {
    title: string;
    artist: string;
    url: string;
    source: string;
    duration: number;
  }
): Promise<void> {
  await getOrCreateUser(userId);
  await prisma.$transaction([
    prisma.listeningHistory.create({
      data: {
        userId,
        guildId,
        trackTitle: track.title,
        trackArtist: track.artist,
        trackUrl: track.url,
        trackSource: track.source,
        durationSeconds: track.duration,
      },
    }),
    prisma.user.update({
      where: { userId },
      data: {
        totalTracksPlayed: { increment: 1 },
        totalListeningSeconds: { increment: track.duration },
      },
    }),
  ]);
}

export async function getUserHistory(userId: string, limit = 50) {
  return prisma.listeningHistory.findMany({
    where: { userId },
    orderBy: { playedAt: "desc" },
    take: limit,
  });
}

export async function getTopArtists(userId: string, limit = 3) {
  const history = await prisma.listeningHistory.groupBy({
    by: ["trackArtist"],
    where: { userId },
    _count: { trackArtist: true },
    orderBy: { _count: { trackArtist: "desc" } },
    take: limit,
  });
  return history.map((h) => ({ artist: h.trackArtist, count: h._count.trackArtist }));
}

export async function isDjCommandLocked(
  guildId: string,
  commandName: string
): Promise<boolean> {
  const guild = await getOrCreateGuild(guildId);
  if (!guild.djEnabled) return false;
  return guild.djLockedCommands.includes(commandName.toLowerCase());
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Database disconnected");
}
