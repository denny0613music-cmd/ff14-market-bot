import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder } from 'discord.js';
import { REST } from '@discordjs/rest';
import fetch from 'node-fetch';

/**
 * ===== Render Web Service 必須開 Port =====
 * 這個 HTTP server 只為了讓 Render 偵測到服務存活
 * 不影響 Discord Bot 功能
 */
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}).listen(port, () => {
  console.log(`HTTP server listening on ${port}`);
});

// ===== 快取設定（10 分鐘）=====
const CACHE_TTL = 10 * 60 * 1000;
const priceCache = new Map();

// ===== Discord Client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ===== Slash 指令定義 =====
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 市場價格（Universalis）')
  .addStringOption(option =>
    option
      .setName('item_id')
      .setDescription('物品 ID（例如：5333）')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('realm')
      .setDescription('伺服器名稱（例如：Bahamut）')
      .setRequired(true)
  );

// ===== 註冊 Slash 指令 =====
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: [command.toJSON()] }
    );
    console.log('✅ Slash command registered');
  } catch (err) {
    console.error('❌ Failed to register command', err);
  }
})();

// ===== 查價（含快取）=====
async function getPrice(realm, itemId) {
  const key = `${realm}_${itemId}`;
  const now = Date.now();

  if (priceCache.has(key)) {
    const cached = priceCache.get(key);
    if (cached.expiresAt > now) {
      return { data: cached.data, fromCache: true };
    }
  }

  const url = `https://universalis.app/api/zh-TW/realm/${encodeURIComponent(realm)}/${itemId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Universalis API error');

  const data = await res.json();

  priceCache.set(key, {
    data,
    expiresAt: now + CACHE_TTL,
  });

  return { data, fromCache: false };
}

// ===== Discord 互動處理 =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  await interaction.deferReply();

  const itemId = interaction.options.getString('item_id');
  const realm = interaction.options.getString('realm');

  try {
    const result = await getPrice(realm, itemId);
    const listing = result.data.listings?.[0];

    if (!listing) {
      return interaction.editReply('❌ 查不到該物品的市場資料');
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 物品 ID：${itemId}`)
      .addFields(
        { name: '最低單價', value: `${listing.pricePerUnit} Gil`, inline: true },
        { name: '數量', value: `${listing.quantity}`, inline: true }
      )
      .setFooter({
        text: result.fromCache ? '⚡ 快取資料（10 分鐘內）' : '🌐 即時查詢'
      });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ 查詢失敗，請稍後再試');
  }
});

// ===== 登入 Discord =====
client.login(process.env.DISCORD_TOKEN);
