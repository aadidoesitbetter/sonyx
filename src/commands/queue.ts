import { SlashCommandBuilder, TextChannel } from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { playerManager } from "../utils/player";
import {
  checkVoice,
  checkPlaying,
  checkQueue,
  checkDj,
  getMember,
  replyError,
} from "../utils/checks";
import { baseEmbed, successEmbed, errorEmbed } from "../utils/embeds";
import { formatDuration } from "../utils/format";
import { sendPaginator, chunkArray } from "../utils/paginator";
import { getOrCreateGuild, getUserHistory, getTopArtists } from "../utils/db";

function registerQueueCommands(): void {
  registry.register({
    name: "queue",
    description: "Show the current queue",
    aliases: ["q"],
    category: "Queue",
    execute: async (ctx) => {
      const player = playerManager.get(ctx.guildId);
      if (!player?.current && (!player || player.queue.length === 0)) {
        return replyError(ctx, "The queue is empty.");
      }

      const allTracks = player!.current
        ? [player!.current, ...player!.queue]
        : player!.queue;

      const lines = allTracks.map(
        (t, i) =>
          `**${i + 1}.** [${t.title}](${t.url}) — ${formatDuration(t.duration)} • ${t.requester.username}`
      );

      const pages = chunkArray(lines, 10).map((chunk, i, arr) =>
        baseEmbed()
          .setTitle("📋 Queue")
          .setDescription(chunk.join("\n"))
          .setFooter({
            text: `Total duration: ${formatDuration(player!.totalQueueDuration())} • Page ${i + 1}/${arr.length}`,
          })
      );

      const target = ctx.interaction ?? ctx.message!;
      await sendPaginator(target as never, { embeds: pages, userId: ctx.userId });
    },
  });

  registry.register({
    name: "clear",
    description: "Clear the queue",
    category: "Queue",
    djLock: true,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "clear"))) return;
      const player = playerManager.get(ctx.guildId);
      if (!player) return replyError(ctx, "Nothing is playing.");
      player.queue = [];
      const embed = successEmbed("Queue cleared.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "remove",
    description: "Remove a track from the queue",
    category: "Queue",
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("position").setDescription("Queue position").setRequired(true).setMinValue(1)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkQueue(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const pos =
        parseInt(ctx.args[0] ?? "", 10) ||
        ctx.interaction?.options.getInteger("position", true) ||
        0;

      if (pos < 1 || pos > player.queue.length) {
        return replyError(ctx, "Invalid queue position.");
      }

      const removed = player.queue.splice(pos - 1, 1)[0];
      const embed = successEmbed(`Removed **${removed.title}** from the queue.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "move",
    description: "Move a track in the queue",
    category: "Queue",
    djLock: true,
    slashData: new SlashCommandBuilder()
      .addIntegerOption((o) =>
        o.setName("from").setDescription("From position").setRequired(true).setMinValue(1)
      )
      .addIntegerOption((o) =>
        o.setName("to").setDescription("To position").setRequired(true).setMinValue(1)
      ) as never,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "move"))) return;
      if (!(await checkQueue(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;

      const from =
        parseInt(ctx.args[0] ?? "", 10) ||
        ctx.interaction?.options.getInteger("from", true) ||
        0;
      const to =
        parseInt(ctx.args[1] ?? "", 10) ||
        ctx.interaction?.options.getInteger("to", true) ||
        0;

      if (from < 1 || from > player.queue.length || to < 1 || to > player.queue.length) {
        return replyError(ctx, "Invalid queue positions.");
      }

      const [track] = player.queue.splice(from - 1, 1);
      player.queue.splice(to - 1, 0, track);
      const embed = successEmbed(`Moved **${track.title}** to position **${to}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "shuffle",
    description: "Shuffle the queue",
    category: "Queue",
    djLock: true,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "shuffle"))) return;
      if (!(await checkQueue(ctx))) return;
      playerManager.get(ctx.guildId)!.shuffle();
      const embed = successEmbed("Queue shuffled.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "removedupes",
    description: "Remove duplicate tracks from the queue",
    category: "Queue",
    djLock: true,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "removedupes"))) return;
      const player = playerManager.get(ctx.guildId);
      if (!player?.queue.length) return replyError(ctx, "The queue is empty.");
      const removed = player.removeDupes();
      const embed = successEmbed(`Removed **${removed}** duplicate(s).`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "leavecleanup",
    description: "Remove songs from users who left the VC",
    category: "Queue",
    djLock: true,
    execute: async (ctx) => {
      if (!(await checkDj(ctx, "leavecleanup"))) return;
      const player = playerManager.get(ctx.guildId);
      if (!player?.queue.length) return replyError(ctx, "The queue is empty.");

      const member = getMember(ctx);
      const vc = member?.voice.channel;
      if (!vc) return replyError(ctx, "You must be in a voice channel.");

      const present = new Set(vc.members.map((m) => m.id));
      const before = player.queue.length;
      player.queue = player.queue.filter((t) => present.has(t.requester.id));
      const removed = before - player.queue.length;

      const embed = successEmbed(`Removed **${removed}** track(s) from absent users.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "autoleavecleanup",
    description: "Toggle automatic leave cleanup",
    category: "Queue",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("on or off")
        .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })
    ) as never,
    execute: async (ctx) => {
      const { updateGuild } = await import("../utils/db");
      const guild = await getOrCreateGuild(ctx.guildId);
      const mode = ctx.args[0]?.toLowerCase() || ctx.interaction?.options.getString("mode") || "";
      const enabled = mode === "on" ? true : mode === "off" ? false : !guild.leaveCleanup;
      await updateGuild(ctx.guildId, { leaveCleanup: enabled });

      const player = playerManager.getOrCreate(ctx.guildId);
      player.leaveCleanup = enabled;

      const embed = successEmbed(`Auto leave cleanup is now **${enabled ? "ON" : "OFF"}**.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "addprevious",
    description: "Add the previously played track to the queue",
    category: "Queue",
    execute: async (ctx) => {
      const player = playerManager.get(ctx.guildId);
      if (!player?.history[0]) return replyError(ctx, "No previous track found.");
      player.queue.unshift(player.history[0]);
      const embed = successEmbed(`Added **${player.history[0].title}** to the front of the queue.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "addsimilarsongs",
    description: "Add similar songs to the queue",
    category: "Queue",
    slashData: new SlashCommandBuilder().addIntegerOption((o) =>
      o.setName("amount").setDescription("Number of songs").setMinValue(1).setMaxValue(20)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      const amount =
        parseInt(ctx.args[0] ?? "5", 10) ||
        ctx.interaction?.options.getInteger("amount") ||
        5;
      const player = playerManager.get(ctx.guildId)!;
      await player.addSimilar(amount);
      const embed = successEmbed(`Added up to **${amount}** similar songs.`);
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "history",
    description: "Show your listening history",
    category: "Queue",
    execute: async (ctx) => {
      const history = await getUserHistory(ctx.userId);
      if (!history.length) return replyError(ctx, "No listening history yet.");

      const user = await import("../utils/db").then((m) => m.getOrCreateUser(ctx.userId));
      const topArtists = await getTopArtists(ctx.userId);

      const lines = history.map(
        (h) =>
          `**${h.trackTitle}** — ${h.trackArtist} • ${formatDuration(h.durationSeconds)} • <t:${Math.floor(h.playedAt.getTime() / 1000)}:R>`
      );

      const pages = chunkArray(lines, 10).map((chunk, i, arr) =>
        baseEmbed()
          .setTitle("📜 Your Listening History")
          .setDescription(chunk.join("\n"))
          .setFooter({
            text: `Tracks: ${user.totalTracksPlayed} • Time: ${formatDuration(user.totalListeningSeconds)} • Page ${i + 1}/${arr.length}`,
          })
      );

      if (topArtists.length) {
        pages[0].addFields({
          name: "Top Artists",
          value: topArtists.map((a) => `${a.artist} (${a.count})`).join(", "),
        });
      }

      const target = ctx.interaction ?? ctx.message!;
      await sendPaginator(target as never, { embeds: pages, userId: ctx.userId });
    },
  });

  registry.register({
    name: "search",
    description: "Search for a song and pick from results",
    category: "Queue",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o.setName("query").setDescription("Search query").setRequired(true)
    ) as never,
    execute: async (ctx) => {
      const vc = await checkVoice(ctx);
      if (!vc) return;

      const query = ctx.args.join(" ") || ctx.interaction?.options.getString("query") || "";
      const player = await playerManager.loadGuildSettings(ctx.guildId);
      const member = getMember(ctx);
      if (!member) return;

      let tracks;
      try {
        tracks = await player.resolve(query, member.user);
      } catch (err) {
        return replyError(ctx, err instanceof Error ? err.message : "Search failed.");
      }

      const results = tracks.slice(0, 10);
      const list = results
        .map((t, i) => `**${i + 1}.** ${t.title} — ${t.artist} (${formatDuration(t.duration)})`)
        .join("\n");

      const embed = baseEmbed()
        .setTitle("🔍 Search Results")
        .setDescription(`${list}\n\nType a number (1-10) within 30 seconds.`);

      const channel = (ctx.interaction?.channel ?? ctx.message?.channel) as TextChannel;
      const msg = ctx.interaction
        ? await ctx.interaction.reply({ embeds: [embed], fetchReply: true }).then((r) => r as unknown as import("discord.js").Message)
        : await ctx.message!.reply({ embeds: [embed] });

      const collector = channel.createMessageCollector({
        filter: (m) => m.author.id === ctx.userId && /^[1-9]$|^10$/.test(m.content.trim()),
        time: 30_000,
        max: 1,
      });

      collector.on("collect", async (m) => {
        const idx = parseInt(m.content, 10) - 1;
        const track = results[idx];
        if (!track) return;

        player.queue.push(track);
        if (!player.current) {
          await player.startPlayback(channel);
        } else {
          await channel.send({ embeds: [successEmbed(`Added **${track.title}** to the queue.`)] });
        }
        await m.react("✅");
      });

      collector.on("end", async (collected) => {
        if (!collected.size) {
          await channel.send({ embeds: [errorEmbed("Search timed out.")] }).then((m) =>
            setTimeout(() => m.delete().catch(() => {}), 5000)
          );
        }
      });
    },
  });

  registry.register({
    name: "voteskip",
    description: "Vote to skip or toggle vote-skip setting",
    category: "Queue",
    slashData: new SlashCommandBuilder().addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("on/off to toggle setting (admin)")
        .addChoices({ name: "On", value: "on" }, { name: "Off", value: "off" })
    ) as never,
    execute: async (ctx) => {
      const mode = ctx.args[0]?.toLowerCase() || ctx.interaction?.options.getString("mode") || "";
      if (mode === "on" || mode === "off") {
        const { updateGuild } = await import("../utils/db");
        const guild = await getOrCreateGuild(ctx.guildId);
        const enabled = mode === "on";
        await updateGuild(ctx.guildId, { voteSkipEnabled: enabled });
        const player = playerManager.getOrCreate(ctx.guildId);
        player.voteSkipEnabled = enabled;
        const embed = successEmbed(`Vote skip is now **${enabled ? "ON" : "OFF"}**.`);
        if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
        else await ctx.message!.reply({ embeds: [embed] });
        return;
      }

      if (!(await checkPlaying(ctx))) return;
      const player = playerManager.get(ctx.guildId)!;
      const member = getMember(ctx);
      const vc = member?.voice.channel;
      if (!vc) return replyError(ctx, "You must be in a voice channel.");

      const voters = player.activeVoteSkip ?? new Set<string>();
      voters.add(ctx.userId);
      player.activeVoteSkip = voters;

      const needed = Math.ceil(vc.members.filter((m) => !m.user.bot).size / 2);
      if (voters.size >= needed) {
        player.activeVoteSkip = null;
        await player.skip();
        const embed = successEmbed("Vote passed! Skipping track.");
        if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
        else await ctx.message!.reply({ embeds: [embed] });
      } else {
        const embed = baseEmbed().setDescription(
          `Vote skip: **${voters.size}/${needed}** votes. React ✅ on this message!`
        );
        const reply = ctx.interaction
          ? await ctx.interaction.reply({ embeds: [embed], fetchReply: true })
          : await ctx.message!.reply({ embeds: [embed] });
        await (reply as import("discord.js").Message).react("✅");
      }
    },
  });
}

registerQueueCommands();
