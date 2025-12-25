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
   ✅ 支援兩種格式：
   1) 陣列：[{id, zh, en}, ...]
   2) 物件：{"1675":"鐵礦", ...}
===================== */
console.log('📦 Loading items_zh_tw.json (or items_zh.json)...');

// 你如果已經有繁中檔，優先用它；沒有就先用舊的 items_zh.json
const ITEMS_PATH = fs.existsSync('./items_zh_tw.json') ? './items_zh_tw.json' : './items_zh.json';
const RAW = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));

let ITEMS = [];
if (Array.isArray(RAW)) {
  // 格式 1：陣列
  ITEMS = RAW;
} else if (RAW && typeof RAW === 'object') {
  // 格式 2：物件（id -> name）
  ITEMS = Object.entries(RAW).map(([id, name]) => ({
    id: Number(id),
    zh: String(name),
    en: '' // 如果你沒有英文也沒關係
  }));
} else {
  throw new Error('items json format invalid');
}

console.log(`✅ Loaded ${ITEMS.length} items from ${ITEMS_PATH}`);

/* =====================
   ✅ 載入手動繁中字典（items_zh_manual.json）
   優先順序：手動繁中 > 自動檔 > 英文 fallback
===================== */
let ITEMS_MANUAL = {};
try {
  if (fs.existsSync('./items_zh_manual.json')) {
    ITEMS_MANUAL = JSON.parse(fs.readFileSync('./items_zh_manual.json', 'utf8'));
    console.log(`🧩 Manual dict loaded: ${Object.keys(ITEMS_MANUAL).length} items`);
  } else {
    console.log('⚠️ items_zh_manual.json not found, manual dict disabled');
  }
} catch (e) {
  console.log('⚠️ items_zh_manual.json invalid JSON, manual dict disabled');
  ITEMS_MANUAL = {};
}

function getItemName(itemId, fallbackEn = '') {
  const key = String(itemId);
  return ITEMS_MANUAL[key] || fallbackEn || `ID:${key}`;
}

/* =====================
   建立搜尋索引（繁中+英文）
   ✅ 三段式：精確→前綴→包含

   重要：zhRaw 改成「最終顯示名」
   這樣 Fire Shard 這類，會用手動字典顯示成 火之碎晶
===================== */
function normalizeName(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/　/g, '');
}

const SEARCH_INDEX = ITEMS.map(i => {
  const finalZh = getItemName(i.id, i.zh || ''); // 手動優先（若沒有就用自動 zh）
  return {
    id: i.id,
    zh: normalizeName(finalZh),
    en: normalizeName(i.en),
    zhRaw: finalZh || '',
    enRaw: i.en || ''
  };
});

function findItems(keyword, limit = 8) {
  const key = normalizeName(keyword);
  if (!key) return [];

  // 1) 精確
  const exact = SEARCH_INDEX.filter(i => i.zh === key || i.en === key);
  if (exact.length) return exact.slice(0, limit);

  // 2) 前綴
  const prefix = SEARCH_INDEX
    .filter(i => i.zh.startsWith(key) || i.en.startsWith(key))
    .sort((a, b) => (a.zh.length || 9999) - (b.zh.length || 9999));

  // 3) 包含
  const contains = SEARCH_INDEX
    .filter(i => i.zh.includes(key) || i.en.includes(key))
    .sort((a, b) => (a.zh.length || 9999) - (b.zh.length || 9999));

  // 合併去重（避免 prefix/contains 重覆）
  const seen = new Set();
  const merged = [];
  for (const it of [...prefix, ...contains]) {
    const k = String(it.id);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(it);
    if (merged.length >= limit) break;
  }

  return merged;
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
  .setDescription('查詢 FF14 繁中服市價（支援繁中/英文模糊搜尋）')
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
    const matches = findItems(keyword, 8);

    if (!matches.length) {
      return interaction.editReply(`❌ 找不到符合「${keyword}」的物品（試試看多打幾個字）`);
    }

    // 多候選：列出建議
    if (matches.length > 1) {
      const list = matches
        .map((m, idx) => `${idx + 1}. ${m.zhRaw || m.enRaw} (ID:${m.id})`)
        .join('\n');

      return interaction.editReply(
        `🔎 我找到多個可能的物品，請把名稱打更完整一點再查：\n` +
        `${list}`
      );
    }

    // 只有一筆：直接查價
    const item = matches[0];

    const price = await fetchPrice(item.id);
    if (!price) {
      return interaction.editReply('❌ 此物品在繁中服沒有市場資料');
    }

    // ✅ 最終顯示名：手動繁中 > 自動檔 > 英文 > ID
    const displayName = item.zhRaw || item.enRaw || `ID:${item.id}`;

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${displayName}`)
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
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ 查詢失敗，請再試一次');
      } else {
        await interaction.reply('❌ 查詢失敗，請再試一次');
      }
    } catch {}
  }
});

/* =====================
   Login
===================== */
client.login(process.env.DISCORD_TOKEN);
console.log('🤖 Bot logging in...');
