import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  EmbedBuilder,
  MessageFlags
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
   載入物品 JSON
===================== */
console.log('📦 Loading items_zh_tw.json (or items_zh.json)...');

const ITEMS_PATH = fs.existsSync('./items_zh_tw.json')
  ? './items_zh_tw.json'
  : './items_zh.json';

const RAW = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));

let ITEMS = [];
if (Array.isArray(RAW)) {
  ITEMS = RAW;
} else if (RAW && typeof RAW === 'object') {
  ITEMS = Object.entries(RAW).map(([id, name]) => ({
    id: Number(id),
    zh: '',
    en: String(name)
  }));
} else {
  throw new Error('items json format invalid');
}

console.log(`✅ Loaded ${ITEMS.length} items from ${ITEMS_PATH}`);

/* =====================
   手動繁中字典
===================== */
let ITEMS_MANUAL = {};
if (fs.existsSync('./items_zh_manual.json')) {
  ITEMS_MANUAL = JSON.parse(fs.readFileSync('./items_zh_manual.json', 'utf8'));
  console.log(`🧩 Manual dict loaded: ${Object.keys(ITEMS_MANUAL).length} items`);
}

/* =====================
   建立搜尋索引（🔥關鍵修正）
===================== */
function normalizeName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/　/g, '');
}

const SEARCH_INDEX = ITEMS.map(i => {
  // ✅ 搜尋 / 顯示名稱優先順序
  // 手動繁中 > 自動 zh > 英文 en > ID
  const manualZh = ITEMS_MANUAL[String(i.id)];
  const finalName = manualZh || i.zh || i.en || `ID:${i.id}`;

  return {
    id: i.id,
    key: normalizeName(finalName),
    raw: finalName
  };
});

function findItems(keyword, limit = 8) {
  const key = normalizeName(keyword);
  if (!key) return [];

  const exact = SEARCH_INDEX.filter(i => i.key === key);
  if (exact.length) return exact.slice(0, limit);

  const prefix = SEARCH_INDEX.filter(i => i.key.startsWith(key));
  const contains = SEARCH_INDEX.filter(i => i.key.includes(key));

  const merged = [];
  const seen = new Set();

  for (const i of [...prefix, ...contains]) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    merged.push(i);
    if (merged.length >= limit) break;
  }

  return merged;
}

/* =====================
   快取
===================== */
const CACHE_TTL = 10 * 60 * 1000;
const priceCache = new Map();

/* =====================
   繁中服
===================== */
const ZH_WORLDS = [
  'Bahamut','Tonberry','Typhon','Kujata','Garuda',
  'Ifrit','Ramuh','Ultima','Valefor','Tiamat','Shinryu'
];

/* =====================
   Discord Client
===================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* =====================
   Slash Command
===================== */
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 繁中服市價')
  .addStringOption(opt =>
    opt.setName('item')
      .setDescription('物品名稱')
      .setRequired(true)
  );

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: [command.toJSON()] }
);
console.log('✅ Slash command registered');

/* =====================
   查價
===================== */
async function fetchPrice(itemId) {
  const now = Date.now();
  const key = String(itemId);

  if (priceCache.has(key)) {
    const c = priceCache.get(key);
    if (c.expires > now) return { ...c.data, cached: true };
  }

  let prices = [];
  let lastSales = [];

  for (const world of ZH_WORLDS) {
    try {
      const res = await fetch(`https://universalis.app/api/${world}/${itemId}?listings=1&entries=1`);
      if (!res.ok) continue;
      const data = await res.json();

      if (data.listings?.length) prices.push(data.listings[0].pricePerUnit);
      if (data.recentHistory?.length) lastSales.push(data.recentHistory[0].pricePerUnit);
    } catch {}
  }

  if (!prices.length) return null;

  const result = {
    min: Math.min(...prices),
    avg: Math.round(prices.reduce((a,b)=>a+b,0)/prices.length),
    last: lastSales[0] || prices[0],
    cached: false
  };

  priceCache.set(key, { data: result, expires: now + CACHE_TTL });
  return result;
}

/* =====================
   Interaction
===================== */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 0 });
    }

    const keyword = interaction.options.getString('item');
    const matches = findItems(keyword);

    if (!matches.length) {
      return interaction.editReply(`❌ 找不到符合「${keyword}」的物品`);
    }

    if (matches.length > 1) {
      return interaction.editReply(
        '🔎 找到多個物品，請輸入更完整名稱：\n' +
        matches.map((m,i)=>`${i+1}. ${m.raw} (ID:${m.id})`).join('\n')
      );
    }

    const item = matches[0];
    const price = await fetchPrice(item.id);
    if (!price) return interaction.editReply('❌ 沒有市場資料');

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${item.raw}`)
      .addFields(
        { name: '最低價', value: `${price.min.toLocaleString()} Gil`, inline: true },
        { name: '平均價', value: `${price.avg.toLocaleString()} Gil`, inline: true },
        { name: '最近成交', value: `${price.last.toLocaleString()} Gil`, inline: true }
      )
      .setFooter({ text: price.cached ? '⚡ 快取資料' : '🌐 即時查詢' });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    if (err?.code === 10062) return;
    console.error(err);
    try {
      await interaction.editReply('❌ 發生錯誤');
    } catch {}
  }
});

/* =====================
   Login
===================== */
client.login(process.env.DISCORD_TOKEN);
console.log('🤖 Bot logging in...');
