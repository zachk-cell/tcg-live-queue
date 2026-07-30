// Discord mirror.
//
// Keeps a single auto-updating "live queue" message in a channel, and gives
// mods slash-style commands to fulfill / bump slots without opening the web app.
//
// Stays dormant unless DISCORD_ENABLED=true and a bot token + channel id are set.
// The web dashboard is the primary control surface; this mirrors it so mods and
// buyers can follow along in Discord.

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

const MAX_SHOWN = 15; // how many upcoming slots to show in the embed

export function discordEnabled() {
  return process.env.DISCORD_ENABLED === 'true' && !!process.env.DISCORD_BOT_TOKEN;
}

function buildQueueMessage(queue) {
  const snap = queue.snapshot();
  if (!snap.stats.live) {
    return '**🔴 Queue closed**\n_The live isn\'t running right now. The queue reopens when the next live starts._\n' +
      `_Updated <t:${Math.floor(Date.now() / 1000)}:R>_`;
  }
  const q = snap.queue;
  const lines = [];
  lines.push(`**🟢 LIVE QUEUE — ${q.length} in line**`);
  if (snap.stats.priorityCount) {
    lines.push(`⭐ ${snap.stats.priorityCount} priority`);
  }
  lines.push('');
  if (!q.length) {
    lines.push('_Queue is empty — waiting on orders._');
  } else {
    for (const e of q.slice(0, MAX_SHOWN)) {
      // Public-safe: username + position + priority only. No totals, items, or
      // order counts — matches the public web view.
      const star = e.bumped ? '🔺' : e.isPriority ? '⭐' : '　';
      lines.push(`\`${String(e.position).padStart(2)}\` ${star} **${e.buyer}**`);
    }
    if (q.length > MAX_SHOWN) lines.push(`_…and ${q.length - MAX_SHOWN} more_`);
  }
  lines.push('');
  lines.push('_Order totals and personal details are private and never shown here._');
  lines.push(`_Updated <t:${Math.floor(Date.now() / 1000)}:R>_`);
  return lines.join('\n');
}

export async function startDiscord(queue) {
  if (!discordEnabled()) {
    console.log('[discord] disabled (set DISCORD_ENABLED=true + token to enable)');
    return null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const channelId = process.env.DISCORD_CHANNEL_ID;
  let liveMessage = null;
  let dirty = false;

  const commands = [
    new SlashCommandBuilder().setName('queue').setDescription('Show/refresh the live queue'),
    new SlashCommandBuilder()
      .setName('fulfill')
      .setDescription('Mark the top (or a named buyer) slot fulfilled')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption((o) => o.setName('buyer').setDescription('Buyer name (optional; defaults to top)')),
    new SlashCommandBuilder()
      .setName('bump')
      .setDescription('Bump a buyer to the top')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addStringOption((o) => o.setName('buyer').setDescription('Buyer name').setRequired(true)),
  ].map((c) => c.toJSON());

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    try {
      const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
      await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
    } catch (e) {
      console.warn('[discord] command registration failed:', e.message);
    }
    await refresh(true);
  });

  function findByBuyer(name) {
    const q = queue.activeQueue();
    if (!name) return q[0];
    const lower = name.toLowerCase();
    return q.find((e) => e.buyer.toLowerCase().includes(lower));
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === 'queue') {
        await interaction.reply({ content: 'Refreshing…', ephemeral: true });
        await refresh(true);
      } else if (interaction.commandName === 'fulfill') {
        const target = findByBuyer(interaction.options.getString('buyer'));
        if (!target) return interaction.reply({ content: 'No matching slot.', ephemeral: true });
        queue.markFulfilled(target.key);
        await interaction.reply({ content: `✅ Fulfilled **${target.buyer}**.`, ephemeral: true });
      } else if (interaction.commandName === 'bump') {
        const target = findByBuyer(interaction.options.getString('buyer'));
        if (!target) return interaction.reply({ content: 'No matching slot.', ephemeral: true });
        queue.bump(target.key);
        await interaction.reply({ content: `🔺 Bumped **${target.buyer}** to top.`, ephemeral: true });
      }
    } catch (e) {
      console.error('[discord] interaction error:', e.message);
    }
  });

  async function refresh(force = false) {
    if (!channelId) return;
    if (!force && !dirty) return;
    dirty = false;
    try {
      const channel = await client.channels.fetch(channelId);
      const content = buildQueueMessage(queue);
      if (liveMessage) {
        await liveMessage.edit(content);
      } else {
        // Fresh start (e.g. after a redeploy): clear any previous queue
        // messages this bot left behind so the channel keeps a single message.
        try {
          const recent = await channel.messages.fetch({ limit: 25 });
          for (const m of recent.values()) {
            if (m.author.id === client.user.id) { try { await m.delete(); } catch {} }
          }
        } catch {}
        liveMessage = await channel.send(content);
        try { await liveMessage.pin(); } catch {}
      }
    } catch (e) {
      console.warn('[discord] refresh failed:', e.message);
      liveMessage = null;
    }
  }

  // Coalesce rapid changes: mark dirty on change, flush on an interval so we
  // never hit Discord's edit rate limits during a busy live.
  queue.on('change', () => { dirty = true; });
  const timer = setInterval(() => refresh(false), 4000);
  timer.unref?.();

  await client.login(process.env.DISCORD_BOT_TOKEN);
  return client;
}
