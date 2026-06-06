import { SlashCommandBuilder, User as DUser, TextChannel } from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { prisma } from "../utils/db";
import { playerManager } from "../utils/player";
import { checkVoice, getMember, replyError } from "../utils/checks";
import { baseEmbed, successEmbed } from "../utils/embeds";
import { formatDuration } from "../utils/format";
import { sendPaginator, chunkArray } from "../utils/paginator";
import { config } from "../config";

async function reply(ctx: CommandContext, embed: ReturnType<typeof baseEmbed>): Promise<void> {
  if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
  else await ctx.message!.reply({ embeds: [embed] });
}

function registerPlaylistCommands(): void {
  registry.register({
    name: "playlist",
    description: "Manage personal playlists",
    category: "Playlists",
    usage: ",playlist <create|delete|list|add|remove|load|edit|steal|view> [args]",
    slashData: new SlashCommandBuilder()
      .addSubcommand((s) =>
        s.setName("create").setDescription("Create a playlist").addStringOption((o) =>
          o.setName("name").setDescription("Playlist name").setRequired(true)
        )
      )
      .addSubcommand((s) =>
        s.setName("delete").setDescription("Delete a playlist").addStringOption((o) =>
          o.setName("name").setDescription("Playlist name").setRequired(true)
        )
      )
      .addSubcommand((s) => s.setName("list").setDescription("List your playlists"))
      .addSubcommand((s) =>
        s
          .setName("add")
          .setDescription("Add a song to a playlist")
          .addStringOption((o) => o.setName("name").setDescription("Playlist").setRequired(true))
          .addStringOption((o) => o.setName("query").setDescription("Song URL or query").setRequired(true))
      )
      .addSubcommand((s) =>
        s.setName("load").setDescription("Load a playlist into the queue").addStringOption((o) =>
          o.setName("name").setDescription("Playlist name").setRequired(true)
        )
      )
      .addSubcommand((s) =>
        s
          .setName("view")
          .setDescription("View a playlist")
          .addStringOption((o) => o.setName("name").setDescription("Playlist name").setRequired(true))
      ) as never,
    execute: async (ctx) => {
      const sub =
        ctx.interaction?.options.getSubcommand() ?? ctx.args[0]?.toLowerCase();
      const rest = ctx.interaction ? [] : ctx.args.slice(1);

      if (sub === "create" || sub === "create") {
        const name =
          ctx.interaction?.options.getString("name") ?? rest.join(" ");
        if (!name) return replyError(ctx, "Provide a playlist name.");
        try {
          await prisma.playlist.create({ data: { ownerId: ctx.userId, name } });
          await reply(ctx, successEmbed(`Created playlist **${name}**.`));
        } catch {
          await replyError(ctx, "A playlist with that name already exists.");
        }
        return;
      }

      if (sub === "delete") {
        const name = ctx.interaction?.options.getString("name") ?? rest.join(" ");
        const result = await prisma.playlist.deleteMany({
          where: { ownerId: ctx.userId, name },
        });
        if (!result.count) return replyError(ctx, "Playlist not found.");
        await reply(ctx, successEmbed(`Deleted playlist **${name}**.`));
        return;
      }

      if (sub === "list" || !sub) {
        const playlists = await prisma.playlist.findMany({
          where: { ownerId: ctx.userId },
          include: { _count: { select: { songs: true } }, songs: true },
        });
        if (!playlists.length) return replyError(ctx, "You have no playlists.");

        const lines = playlists.map((p) => {
          const dur = p.songs.reduce((s, song) => s + song.durationSeconds, 0);
          return `**${p.name}** — ${p._count.songs} songs • ${formatDuration(dur)}`;
        });

        const embed = baseEmbed().setTitle("📁 Your Playlists").setDescription(lines.join("\n"));
        await reply(ctx, embed);
        return;
      }

      if (sub === "add" || sub === "addsong") {
        const name = ctx.interaction?.options.getString("name") ?? rest[0];
        const query =
          ctx.interaction?.options.getString("query") ?? rest.slice(1).join(" ");
        if (!name || !query) return replyError(ctx, "Usage: ,playlist add [name] [query]");

        const playlist = await prisma.playlist.findUnique({
          where: { ownerId_name: { ownerId: ctx.userId, name } },
        });
        if (!playlist) return replyError(ctx, "Playlist not found.");

        const member = getMember(ctx);
        if (!member) return;
        const player = playerManager.getOrCreate(ctx.guildId);
        const tracks = await player.resolve(query, member.user);
        const track = tracks[0];
        const count = await prisma.playlistSong.count({ where: { playlistId: playlist.id } });

        await prisma.playlistSong.create({
          data: {
            playlistId: playlist.id,
            trackTitle: track.title,
            trackArtist: track.artist,
            trackUrl: track.url,
            trackSource: track.source,
            durationSeconds: track.duration,
            position: count,
          },
        });
        await reply(ctx, successEmbed(`Added **${track.title}** to **${name}**.`));
        return;
      }

      if (sub === "load") {
        const name = ctx.interaction?.options.getString("name") ?? rest.join(" ");
        const vc = await checkVoice(ctx);
        if (!vc) return;

        const playlist = await prisma.playlist.findFirst({
          where: { ownerId: ctx.userId, name },
          include: { songs: { orderBy: { position: "asc" } } },
        });
        if (!playlist?.songs.length) return replyError(ctx, "Playlist not found or empty.");

        const channel = (ctx.interaction?.channel ?? ctx.message?.channel) as TextChannel;
        const member = getMember(ctx)!;
        const player = await playerManager.loadGuildSettings(ctx.guildId);
        await player.ensurePlayer(vc);

        for (const song of playlist.songs) {
          try {
            const tracks = await player.resolve(song.trackUrl, member.user);
            player.queue.push(...tracks);
          } catch {
            /* skip broken tracks */
          }
        }

        if (!player.current) await player.startPlayback(vc, channel);
        await reply(ctx, successEmbed(`Loaded **${playlist.songs.length}** songs from **${name}**.`));
        return;
      }

      if (sub === "view") {
        const name = ctx.interaction?.options.getString("name") ?? rest.join(" ");
        const playlist = await prisma.playlist.findFirst({
          where: { ownerId: ctx.userId, name },
          include: { songs: { orderBy: { position: "asc" } } },
        });
        if (!playlist) return replyError(ctx, "Playlist not found.");

        const lines = playlist.songs.map(
          (s, i) => `**${i + 1}.** ${s.trackTitle} — ${s.trackArtist} (${formatDuration(s.durationSeconds)})`
        );
        const pages = chunkArray(lines, 10).map((chunk, i, arr) =>
          baseEmbed()
            .setTitle(`📁 ${playlist.name}`)
            .setDescription(chunk.join("\n") || "Empty playlist")
            .setFooter({ text: `Page ${i + 1}/${arr.length}` })
        );
        const target = ctx.interaction ?? ctx.message!;
        await sendPaginator(target as never, { embeds: pages, userId: ctx.userId });
        return;
      }

      if (sub === "edit") {
        const oldName = rest[0];
        const newName = rest.slice(1).join(" ");
        if (!oldName || !newName) return replyError(ctx, "Usage: ,playlist edit [old] [new]");
        const result = await prisma.playlist.updateMany({
          where: { ownerId: ctx.userId, name: oldName },
          data: { name: newName },
        });
        if (!result.count) return replyError(ctx, "Playlist not found.");
        await reply(ctx, successEmbed(`Renamed **${oldName}** to **${newName}**.`));
        return;
      }

      if (sub === "steal") {
        const targetUser = ctx.message?.mentions.users.first();
        const plName = rest.filter((a) => !a.startsWith("<@")).join(" ");
        if (!targetUser || !plName) return replyError(ctx, "Usage: ,playlist steal [@user] [name]");

        const source = await prisma.playlist.findFirst({
          where: { ownerId: targetUser.id, name: plName },
          include: { songs: true },
        });
        if (!source) return replyError(ctx, "Playlist not found.");

        const copy = await prisma.playlist.create({
          data: { ownerId: ctx.userId, name: `${plName} (copy)` },
        });
        for (const song of source.songs) {
          await prisma.playlistSong.create({
            data: {
              playlistId: copy.id,
              trackTitle: song.trackTitle,
              trackArtist: song.trackArtist,
              trackUrl: song.trackUrl,
              trackSource: song.trackSource,
              durationSeconds: song.durationSeconds,
              position: song.position,
            },
          });
        }
        await reply(ctx, successEmbed(`Copied **${plName}** from ${targetUser.username}.`));
        return;
      }

      if (sub === "remove" || sub === "removesong") {
        const name = rest[0];
        if (!name) return replyError(ctx, "Usage: ,playlist remove [name]");
        const playlist = await prisma.playlist.findFirst({
          where: { ownerId: ctx.userId, name },
          include: { songs: { orderBy: { position: "asc" } } },
        });
        if (!playlist?.songs.length) return replyError(ctx, "Playlist not found or empty.");

        const list = playlist.songs
          .map((s, i) => `**${i + 1}.** ${s.trackTitle}`)
          .join("\n");
        const channel = (ctx.interaction?.channel ?? ctx.message?.channel) as TextChannel;
        const embed = baseEmbed()
          .setTitle(`Remove from ${name}`)
          .setDescription(`${list}\n\nReply with a number to remove.`);
        const msg = await channel.send({ embeds: [embed] });

        const collector = channel.createMessageCollector({
          filter: (m) => m.author.id === ctx.userId,
          time: 30_000,
          max: 1,
        });

        collector.on("collect", async (m) => {
          const idx = parseInt(m.content, 10) - 1;
          const song = playlist.songs[idx];
          if (song) {
            await prisma.playlistSong.delete({ where: { id: song.id } });
            await m.reply({ embeds: [successEmbed(`Removed **${song.trackTitle}**.`)] });
          }
        });
        await msg;
        return;
      }

      await replyError(ctx, "Unknown playlist subcommand. Use create, delete, list, add, load, view, edit, steal, or remove.");
    },
  });

  registry.register({
    name: "playlists",
    description: "List your playlists",
    category: "Playlists",
    execute: async (ctx) => {
      ctx.args = ["list", ...ctx.args];
      const cmd = registry.get("playlist")!;
      await cmd.execute(ctx);
    },
  });

  registry.register({
    name: "favourites",
    description: "View your liked songs",
    aliases: ["favs", "liked"],
    category: "Playlists",
    execute: async (ctx) => {
      const liked = await prisma.likedSong.findMany({
        where: { userId: ctx.userId },
        orderBy: { likedAt: "desc" },
      });
      if (!liked.length) return replyError(ctx, "No liked songs yet.");

      const lines = liked.map(
        (s, i) => `**${i + 1}.** [${s.trackTitle}](${s.trackUrl}) — ${s.trackArtist}`
      );
      const pages = chunkArray(lines, 10).map((chunk, i, arr) =>
        baseEmbed()
          .setTitle("❤️ Liked Songs")
          .setDescription(chunk.join("\n"))
          .setFooter({ text: `Page ${i + 1}/${arr.length}` })
      );
      const target = ctx.interaction ?? ctx.message!;
      await sendPaginator(target as never, { embeds: pages, userId: ctx.userId });
    },
  });

  registry.register({
    name: "spotify",
    description: "Play Spotify or link your account",
    category: "Playlists",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("query").setDescription("Spotify link or search")
    ) as never,
    execute: async (ctx) => {
      const query = ctx.args.join(" ") || ctx.interaction?.options.getString("query");
      if (!query) {
        const embed = baseEmbed()
          .setTitle("🎧 Spotify")
          .setDescription(
            `Link your Spotify account on the [dashboard](${config.dashboard.url}/profile) to play Spotify tracks directly.`
          );
        await reply(ctx, embed);
        return;
      }

      const vc = await checkVoice(ctx);
      if (!vc) return;
      const channel = (ctx.interaction?.channel ?? ctx.message?.channel) as TextChannel;
      const member = getMember(ctx)!;
      const player = await playerManager.loadGuildSettings(ctx.guildId);
      await player.ensurePlayer(vc);

      try {
        const tracks = await player.resolve(query, member.user, "spotify");
        player.queue.push(...tracks);
        if (!player.current) await player.startPlayback(vc, channel);
        await reply(ctx, successEmbed(`Added **${tracks.length}** Spotify track(s).`));
      } catch (err) {
        await replyError(ctx, err instanceof Error ? err.message : "Failed to play Spotify track.");
      }
    },
  });
}

registerPlaylistCommands();
