import 'dotenv/config';
import http from 'http';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  EmbedBuilder
} from 'discord.js';
import { REST } from '@discordjs/rest';

/* ===============================
   Render 用 HTTP server（必要）
================================ */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200);
  res.end('FF14 Market Bot Running');
}).listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
});

/* ===============================
   Discord Client
================================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* ===============================
   陸行鳥（繁中）資料中心
================================ */
const CHAOS_CH_DATA_CENTER = '陸行鳥';

/* ===============================
   常用繁中物品 → Item ID（第一批）
   👉 之後可以一直加
================================ */
const ITEM_MAP = {
  '亞拉戈白金幣': 10333,
  '亞拉戈銀幣': 10331,
  '亞拉戈金幣': 10332,
  '平紋布': 5333,
  '棉布': 5329,
  '絲綢': 5334,
  '秘銀錠': 5057,
  '白鋼錠': 5059,
  '鐵錠': 5055,
  '硬銀錠': 5060,
  '魔銀錠': 5061,
  '暗鋼錠': 5062,
  '獸脂': 5536,
  '獸皮': 5529,
  '硬革': 5533,
  '秘銀礦': 5107,
  '白鋼礦': 5109,
  '暗鋼礦': 5111,
  '水晶': 2,
  '火晶': 6,
  '風晶': 4,
  '雷晶': 8,
  '冰晶': 5,
  '土晶': 7
};

/* ===============================
   快取（10 分鐘）
================================ */
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

/* ===============================
   Slash 指令
================================ */
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 繁中服市場價格')
  .addStringOption(opt =>
    opt
      .setName('item')
      .setDescription('繁中物品名稱（例如：亞拉戈白金幣）')
      .setRequired(true)
  );

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

/* ===============================
   註冊指令（只在啟動時）
================================ */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: [command.toJSON()] }
  );
  console.log('✅ Slash command registered');
});

/* ===============================
   查詢 Universalis（資料中心）
================================ */
async function fetchMarket(itemId) {
  const now = Date.now();
  if (cache.has(itemId)) {
    const cached = cache.get(itemId);
    if (cached.expire > now) return cached.data;
  }

  const url = `https://universalis.app/api/v2/${encodeURIComponent(
    CHAOS_CH_DATA_CENTER
  )}/${itemId}?listings=5`;

  const res = await fetch(url);
  if (!res.ok) throw new Error('Universalis API error');

  const data = await res.json();
  cache.set(itemId, { data, expire: now + CACHE_TTL });
  return data;
}

/* ===============================
   Interaction 處理（穩定版）
================================ */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  try {
    await interaction.deferReply({ ephemeral: false });
  } catch {
    console.warn('⚠️ deferReply failed');
    return;
  }

  const name = interaction.options.getString('item').trim();
  const itemId = ITEM_MAP[name];

  if (!itemId) {
    return interaction.editReply(
      `❌ 找不到物品：${name}\n請確認名稱是否在支援清單中`
    );
  }

  try {
    const data = await fetchMarket(itemId);

    if (!data.listings || data.listings.length === 0) {
      return interaction.editReply('⚠️ 目前市場沒有上架資料');
    }

    const prices = data.listings.map(l => l.pricePerUnit);
    const min = Math.min(...prices);
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${name}`)
      .setDescription(`資料中心：${CHAOS_CH_DATA_CENTER}`)
      .addFields(
        { name: '最低價', value: `${min.toLocaleString()} Gil`, inline: true },
        { name: '平均價', value: `${avg.toLocaleString()} Gil`, inline: true },
        {
          name: '最近成交',
          value: data.recentHistory?.[0]
            ? `${data.recentHistory[0].pricePerUnit.toLocaleString()} Gil`
            : '無',
          inline: true
        }
      )
      .setFooter({ text: '資料來源：Universalis' });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ 查詢失敗，請稍後再試');
  }
});

/* ===============================
   登入
================================ */
client.login(process.env.DISCORD_TOKEN);
