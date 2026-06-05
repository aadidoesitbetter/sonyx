import { SlashCommandBuilder } from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { playerManager } from "../utils/player";
import { checkPlaying, replyError } from "../utils/checks";
import { filtersEmbed, successEmbed } from "../utils/embeds";

async function toggleFilter(
  ctx: CommandContext,
  key: keyof typeof playerManager extends never ? never : string,
  toggleFn: (player: ReturnType<typeof playerManager.get>) => void
): Promise<void> {
  if (!(await checkPlaying(ctx))) return;
  const player = playerManager.get(ctx.guildId)!;
  toggleFn(player);
  await player.applyFilters();
  const embed = filtersEmbed(player.getActiveFilterNames());
  if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
  else await ctx.message!.reply({ embeds: [embed] });
}

function registerFilterCommands(): void {
  const toggles: [string, string, (f: ReturnType<typeof playerManager.get> extends infer P ? P : never) => void][] = [
    ["bassboost", "Toggle bass boost", (p) => { if (p) p.filters.bassboost = !p.filters.bassboost; }],
    ["nightcore", "Toggle nightcore effect", (p) => { if (p) p.filters.nightcore = !p.filters.nightcore; }],
    ["8d", "Toggle 8D audio", (p) => { if (p) p.filters.eightD = !p.filters.eightD; }],
    ["karaoke", "Toggle karaoke mode", (p) => { if (p) p.filters.karaoke = !p.filters.karaoke; }],
    ["lowpass", "Toggle low-pass filter", (p) => { if (p) p.filters.lowpass = !p.filters.lowpass; }],
    ["tremolo", "Toggle tremolo effect", (p) => { if (p) p.filters.tremolo = !p.filters.tremolo; }],
    ["vibrato", "Toggle vibrato effect", (p) => { if (p) p.filters.vibrato = !p.filters.vibrato; }],
    ["rotation", "Toggle rotation effect", (p) => { if (p) p.filters.rotation = !p.filters.rotation; }],
  ];

  for (const [name, desc, fn] of toggles) {
    registry.register({
      name,
      description: desc,
      category: "Filters",
      execute: async (ctx) => toggleFilter(ctx, name, fn as never),
    });
  }

  registry.register({
    name: "pitch",
    description: "Adjust pitch (0.1-3.0)",
    category: "Filters",
    slashData: new SlashCommandBuilder().addNumberOption((o) =>
      o.setName("value").setDescription("Pitch value").setRequired(true).setMinValue(0.1).setMaxValue(3)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      let val = parseFloat(ctx.args[0] ?? "");
      if (isNaN(val)) val = ctx.interaction?.options.getNumber("value") ?? 0;
      if (!val || val < 0.1 || val > 3) return replyError(ctx, "Pitch must be between 0.1 and 3.0.");
      const player = playerManager.get(ctx.guildId)!;
      player.filters.pitch = val;
      await player.applyFilters();
      const embed = filtersEmbed(player.getActiveFilterNames());
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "speed",
    description: "Adjust speed (0.1-3.0)",
    category: "Filters",
    slashData: new SlashCommandBuilder().addNumberOption((o) =>
      o.setName("value").setDescription("Speed value").setRequired(true).setMinValue(0.1).setMaxValue(3)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      let val = parseFloat(ctx.args[0] ?? "");
      if (isNaN(val)) val = ctx.interaction?.options.getNumber("value") ?? 0;
      if (!val || val < 0.1 || val > 3) return replyError(ctx, "Speed must be between 0.1 and 3.0.");
      const player = playerManager.get(ctx.guildId)!;
      player.filters.speed = val;
      await player.applyFilters();
      const embed = filtersEmbed(player.getActiveFilterNames());
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "rate",
    description: "Adjust playback rate (0.1-3.0)",
    category: "Filters",
    slashData: new SlashCommandBuilder().addNumberOption((o) =>
      o.setName("value").setDescription("Rate value").setRequired(true).setMinValue(0.1).setMaxValue(3)
    ) as never,
    execute: async (ctx) => {
      if (!(await checkPlaying(ctx))) return;
      let val = parseFloat(ctx.args[0] ?? "");
      if (isNaN(val)) val = ctx.interaction?.options.getNumber("value") ?? 0;
      if (!val || val < 0.1 || val > 3) return replyError(ctx, "Rate must be between 0.1 and 3.0.");
      const player = playerManager.get(ctx.guildId)!;
      player.filters.rate = val;
      await player.applyFilters();
      const embed = filtersEmbed(player.getActiveFilterNames());
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });

  registry.register({
    name: "reset",
    description: "Reset all audio filters",
    category: "Filters",
    execute: async (ctx) => {
      const player = playerManager.get(ctx.guildId);
      if (!player) return replyError(ctx, "No active player.");
      player.resetFilters();
      await player.applyFilters();
      const embed = successEmbed("All filters have been reset.");
      if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
      else await ctx.message!.reply({ embeds: [embed] });
    },
  });
}

registerFilterCommands();
