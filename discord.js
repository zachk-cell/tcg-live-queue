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
} from 'discord.js';

const MAX_SHOWN = 15; // how many upcoming slots to show in the embed

export function discordEnabled() {
  return process.env.DISCORD_ENABLED === 'true' && !!process.env.DISCORD_BOT_TOKEN;
}

function buildQueueMessage(queue) {
  const snap = queue.snapshot();
  const q = snap.queue;
  const lines = [];
  lines.push(`**🟢 LIVE QUEUE — ${q.length} active slot${q.length === 1 ? '' : 's'}**`);
  if (snap.stats.priorityCount) {
    lines.push(`⭐ ${snap.stats.priorityCount} priority · 💵 $${snap.stats.activeValue.toFixed(2)} in queue`);
  }
  lines.push('');
  if (!q.length) {
    lines.push('_Queue is empty — waiting on orders._');
  } else {
    for (const e of q.slice(0, MAX_SHOWN)) {
      const star = e.bumped ? '🔺' : e.isPriority ? '⭐' : '　';
      const multi = e.orderCount > 1 ? ` _(x${e.orderCount} orders)_` : '';
      lines.push(`\`${String(e.position).padStart(2)}\` ${star} **${e.buyer}** — ${e.itemCount} item${e.itemCount === 1 ? '' : 's'} · $${e.total.toFixed(2)}${multi}`);
    }
    if (q.length > MAX_SHOWN) lines.push(`_…and ${q.length - MAX_SHOWN} more_`);
  }
  lines.push('');
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
      .addStringOption((o) => o.setName('buyer').setDescription('Buyer name (optional; defaults to top)')),
    new SlashCommandBuilder()
      .setName('bump')
      .setDescription('Bump a buyer to the top')
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
