import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { registry, CommandContext } from "../utils/commands";
import { getOrCreateGuild, updateGuild, prisma } from "../utils/db";
import { replyError } from "../utils/checks";
import { baseEmbed, successEmbed } from "../utils/embeds";
import { DEFAULT_DJ_LOCKED_COMMANDS } from "../config";

async function reply(ctx: CommandContext, embed: ReturnType<typeof baseEmbed>): Promise<void> {
  if (ctx.interaction) await ctx.interaction.reply({ embeds: [embed] });
  else await ctx.message!.reply({ embeds: [embed] });
}

function registerDjCommands(): void {
  registry.register({
    name: "dj",
    description: "Manage DJ role system",
    category: "DJ",
    usage: ",dj role add|remove [@role] | ,dj toggle | ,dj command [name] lock|unlock | ,dj list",
    slashData: new SlashCommandBuilder()
      .addSubcommandGroup((g) =>
        g
          .setName("role")
          .setDescription("Manage DJ roles")
          .addSubcommand((s) =>
            s
              .setName("add")
              .setDescription("Add a DJ role")
              .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
          )
          .addSubcommand((s) =>
            s
              .setName("remove")
              .setDescription("Remove a DJ role")
              .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
          )
      )
      .addSubcommand((s) => s.setName("toggle").setDescription("Toggle DJ system"))
      .addSubcommand((s) =>
        s
          .setName("command")
          .setDescription("Lock/unlock a command")
          .addStringOption((o) => o.setName("name").setDescription("Command name").setRequired(true))
          .addStringOption((o) =>
            o
              .setName("action")
              .setDescription("lock or unlock")
              .setRequired(true)
              .addChoices({ name: "Lock", value: "lock" }, { name: "Unlock", value: "unlock" })
          )
      )
      .addSubcommand((s) => s.setName("list").setDescription("List DJ config")) as never,
    execute: async (ctx) => {
      const member = ctx.interaction?.member ?? ctx.message?.member;
      if (member && "permissions" in member) {
        const hasPerm = typeof member.permissions === "string"
          ? new PermissionsBitField(BigInt(member.permissions)).has(PermissionFlagsBits.ManageGuild)
          : member.permissions.has(PermissionFlagsBits.ManageGuild);
        if (!hasPerm) {
          return replyError(ctx, "You need Manage Server permission.");
        }
      }

      const subGroup = ctx.interaction?.options.getSubcommandGroup(false);
      const sub = ctx.interaction?.options.getSubcommand(false) ?? ctx.args[0]?.toLowerCase();
      const guild = await getOrCreateGuild(ctx.guildId);

      if (subGroup === "role" || sub === "role") {
        const action = ctx.interaction?.options.getSubcommand() ?? ctx.args[1];
        const role =
          ctx.interaction?.options.getRole("role") ?? ctx.message?.mentions.roles.first();
        if (!role) return replyError(ctx, "Mention a role.");

        if (action === "add") {
          const ids = [...new Set([...guild.djRoleIds, role.id])];
          await updateGuild(ctx.guildId, { djRoleIds: ids });
          await reply(ctx, successEmbed(`Added **${role.name}** as a DJ role.`));
        } else {
          const ids = guild.djRoleIds.filter((id) => id !== role.id);
          await updateGuild(ctx.guildId, { djRoleIds: ids });
          await reply(ctx, successEmbed(`Removed **${role.name}** from DJ roles.`));
        }
        return;
      }

      if (sub === "toggle") {
        const enabled = !guild.djEnabled;
        await updateGuild(ctx.guildId, {
          djEnabled: enabled,
          djLockedCommands: enabled ? [...DEFAULT_DJ_LOCKED_COMMANDS] : [],
        });
        await reply(ctx, successEmbed(`DJ system is now **${enabled ? "ON" : "OFF"}**.`));
        return;
      }

      if (sub === "command") {
        const cmdName = (
          ctx.interaction?.options.getString("name") ?? ctx.args[1]
        )?.toLowerCase();
        const action = (
          ctx.interaction?.options.getString("action") ?? ctx.args[2]
        )?.toLowerCase();
        if (!cmdName || !["lock", "unlock"].includes(action ?? "")) {
          return replyError(ctx, "Usage: ,dj command [name] lock|unlock");
        }

        let locked = [...guild.djLockedCommands];
        if (action === "lock" && !locked.includes(cmdName)) locked.push(cmdName);
        if (action === "unlock") locked = locked.filter((c) => c !== cmdName);

        await updateGuild(ctx.guildId, { djLockedCommands: locked });
        await prisma.djCommand.upsert({
          where: { guildId_commandName: { guildId: ctx.guildId, commandName: cmdName } },
          update: { locked: action === "lock" },
          create: { guildId: ctx.guildId, commandName: cmdName, locked: action === "lock" },
        });
        await reply(ctx, successEmbed(`Command **${cmdName}** is now **${action}ed**.`));
        return;
      }

      if (sub === "list") {
        const roles =
          guild.djRoleIds.length > 0
            ? guild.djRoleIds.map((id) => `<@&${id}>`).join(", ")
            : "None";
        const commands =
          guild.djLockedCommands.length > 0
            ? guild.djLockedCommands.map((c) => `\`${c}\``).join(", ")
            : "None";

        const embed = baseEmbed()
          .setTitle("🎧 DJ Configuration")
          .addFields(
            { name: "Enabled", value: guild.djEnabled ? "Yes" : "No", inline: true },
            { name: "DJ Roles", value: roles },
            { name: "Locked Commands", value: commands }
          );
        await reply(ctx, embed);
        return;
      }

      await replyError(ctx, "Usage: ,dj role add|remove, ,dj toggle, ,dj command, ,dj list");
    },
  });
}

registerDjCommands();
