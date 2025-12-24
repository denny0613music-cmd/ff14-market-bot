import 'dotenv/config';
import fs from 'fs';
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

/* =====================
   HTTP SERVER（Render 必要）
===================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('FF14 Market Bot Alive');
}).listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
});

/* =====================
   載入物品 JSON（一次）
===================== */
console.log('📦 Loading items_zh.json...');
const ITEMS = JSON.parse(fs.readFileSync('./items_zh.json', 'utf8'));
console.log(`✅ Loaded ${ITEMS.length} items`);

/* =====================
   建立搜尋索引
===================== */
const SEARCH_INDEX = ITEMS.map(i => ({
  id: i.id,
  zh: i.zh?.toLowerCase() || '',
  en: i.en?.toLowerCase() || ''
}));

function findItem(keyword) {
  const key = keyword.toLowerCase().trim();

  // 1️⃣ 完全命中
  let exact = SEARCH_INDEX.find(
    i => i.zh === key || i.en === key
  );
  if (exact) return exact;

  // 2️⃣ 模糊包含
  let fuzzy = SEARCH_INDEX.find(
    i => i.zh.includes(key) || i.en.includes(key)
  );
  if (fuzzy) return fuzzy;

  return null;
}

/* =====================
   快取（10 分鐘）
===================== */
const CACHE_TTL = 10 * 60 * 1000;
const priceCache = new Map();

/* =====================
   繁中服清單
===================== */
const ZH_WORLDS = [
  'Bahamut',
  'Tonberry',
  'Typhon',
  'Kujata',
  'Garuda',
  'Ifrit',
  'Ramuh',
  'Ultima',
  'Valefor',
  'Tiamat',
  'Shinryu'
];

/* =====================
   Discord Client
===================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =====================
   Slash 指令
===================== */
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 繁中服市價（支援中英模糊搜尋）')
  .addStringOption(opt =>
    opt.setName('item')
      .setDescription('物品名稱（可只打部分）')
      .setRequired(true)
  );

/* =====================
   註冊指令（只做一次）
===================== */
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: [command.toJSON()] }
);
console.log('✅ Slash command registered');

/* =====================
   查價（繁中服彙總）
===================== */
async function fetchPrice(itemId) {
  const cacheKey = String(itemId);
  const now = Date.now();

  if (priceCache.has(cacheKey)) {
    const c = priceCache.get(cacheKey);
    if (c.expires > now) return { ...c.data, cached: true };
  }

  let prices = [];
  let lastSales = [];

  for (const world of ZH_WORLDS) {
    try {
      const url = `https://universalis.app/api/${world}/${itemId}?listings=1&entries=1`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      if (data.listings?.length) {
        prices.push(data.listings[0].pricePerUnit);
      }
      if (data.recentHistory?.length) {
        lastSales.push(data.recentHistory[0].pricePerUnit);
      }
    } catch {}
  }

  if (!prices.length) return null;

  const result = {
    min: Math.min(...prices),
    avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    last: lastSales[0] || prices[0],
    cached: false
  };

  priceCache.set(cacheKey, {
    data: result,
    expires: now + CACHE_TTL
  });

  return result;
}

/* =====================
   Interaction 處理（防 10062）
===================== */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: false });
    }

    const keyword = interaction.options.getString('item');
    const item = findItem(keyword);

    if (!item) {
      return interaction.editReply(`❌ 找不到符合「${keyword}」的物品`);
    }

    const price = await fetchPrice(item.id);
    if (!price) {
      return interaction.editReply('❌ 此物品在繁中服沒有市場資料');
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${item.zh || item.en}`)
      .addFields(
        { name: '最低價', value: `${price.min.toLocaleString()} Gil`, inline: true },
        { name: '平均價', value: `${price.avg.toLocaleString()} Gil`, inline: true },
        { name: '最近成交', value: `${price.last.toLocaleString()} Gil`, inline: true }
      )
      .setFooter({
        text: price.cached ? '⚡ 快取資料（10 分鐘）' : '🌐 即時查詢'
      });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error('⚠️ interaction error:', err);
    if (!interaction.replied) {
      await interaction.reply('❌ 查詢失敗，請再試一次');
    }
  }
});

/* =====================
   啟動
===================== */
client.login(process.env.DISCORD_TOKEN);
