import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder } from 'discord.js';
import { REST } from '@discordjs/rest';
import fetch from 'node-fetch';

/**
 * ===== Render Web Service 必須開 Port =====
 */
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}).listen(port, () => {
  console.log(`HTTP server listening on ${port}`);
});

/**
 * ===== 設定區 =====
 */
const DEFAULT_DC = process.env.DEFAULT_DC || 'Meteor';
const DEFAULT_WORLD = process.env.DEFAULT_WORLD || 'Tonberry';

// 快取 TTL
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分鐘
// 同一 key 併發去重：同時間很多人查同一個物品，只打一次 API
const inflight = new Map(); // key -> Promise
const cache = new Map();    // key -> { expiresAt, value }

/**
 * ===== Discord Client =====
 */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/**
 * ===== Slash Command：/price item world? dc?
 * item: 物品名稱（中文/英文都可）
 * world: 可選，預設 DEFAULT_WORLD
 * dc: 可選，預設 DEFAULT_DC
 */
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 市場價格（Universalis）')
  .addStringOption(opt =>
    opt.setName('item')
      .setDescription('物品名稱（例：亞拉戈白金幣 / Grade 8 Tincture）')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('world')
      .setDescription(`伺服器（預設：${DEFAULT_WORLD}）`)
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName('dc')
      .setDescription(`資料中心（預設：${DEFAULT_DC}）`)
      .setRequired(false)
  );

/**
 * ===== 註冊 Slash 指令（Guild 指令，更新快）=====
 */
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: [command.toJSON()] }
    );
    console.log('✅ Slash command registered');
  } catch (err) {
    console.error('❌ Failed to register command', err);
  }
});

/**
 * ===== 小工具：快取 / 併發去重 =====
 */
function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * ===== 1) 物品名稱 -> itemId
 * 用 Universalis 的 v2 marketable endpoint 找 itemId
 * q 會走全文搜尋；如果同名很多，取第一個最貼近的
 */
async function resolveItemIdByName(itemName) {
  const q = itemName.trim();
  const url = `https://universalis.app/api/v2/marketable?search=${encodeURIComponent(q)}&limit=8`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`resolveItemId failed: ${res.status}`);

  const data = await res.json();

  // data.results: [{ itemId, itemName, ... }]
  const results = data?.results || [];
  if (!results.length) return null;

  // 優先：完全相同（忽略大小寫 / 全形空白）
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const target = norm(q);

  let best = results.find(r => norm(r.itemName || '') === target);
  if (!best) best = results[0];

  return {
    itemId: best.itemId,
    itemName: best.itemName || q
  };
}

/**
 * ===== 2) 查市場：最低 / 平均 / 最近成交 =====
 * - world：使用 /api/v2/{world}/{itemId}
 * - recentHistory: 最近成交紀錄
 */
async function fetchMarketStats(world, itemId) {
  const url = `https://universalis.app/api/v2/${encodeURIComponent(world)}/${itemId}?listings=10&entries=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market fetch failed: ${res.status}`);
  return res.json();
}

/**
 * ===== 主流程：名稱查詢 + 統計 =====
 */
async function queryPrice({ item, world }) {
  const key = `price:${world}:${item}`.toLowerCase();

  // 快取命中
  const cached = getCache(key);
  if (cached) return { ...cached, fromCache: true };

  // 併發去重
  if (inflight.has(key)) {
    const v = await inflight.get(key);
    return { ...v, fromCache: true, sharedInflight: true };
  }

  const p = (async () => {
    // 先把名稱轉 itemId
    const resolved = await resolveItemIdByName(item);
    if (!resolved) {
      return { ok: false, reason: 'not_found' };
    }

    const market = await fetchMarketStats(world, resolved.itemId);

    const listings = Array.isArray(market.listings) ? market.listings : [];
    const history = Array.isArray(market.recentHistory) ? market.recentHistory : [];

    const lowest = listings.length ? listings[0].pricePerUnit : null;

    // 平均：用最近成交（entries=10），如果沒有就用 listings 的平均
    let avg = null;
    if (history.length) {
      const units = history.map(h => h.pricePerUnit).filter(n => Number.isFinite(n));
      if (units.length) avg = Math.round(units.reduce((a, b) => a + b, 0) / units.length);
    } else if (listings.length) {
      const units = listings.map(l => l.pricePerUnit).filter(n => Number.isFinite(n));
      if (units.length) avg = Math.round(units.reduce((a, b) => a + b, 0) / units.length);
    }

    // 最近成交：取最新 1 筆
    let lastSale = null;
    if (history.length) {
      // Universalis recentHistory 通常已按時間新->舊
      const h = history[0];
      lastSale = {
        pricePerUnit: h.pricePerUnit,
        quantity: h.quantity,
        timestamp: h.timestamp
      };
    }

    const result = {
      ok: true,
      world,
      itemId: resolved.itemId,
      itemName: resolved.itemName || item,
      lowest,
      avg,
      lastSale,
      updated: market.lastUploadTime ? new Date(market.lastUploadTime).toISOString() : null,
    };

    setCache(key, result);
    return result;
  })();

  inflight.set(key, p);

  try {
    const v = await p;
    return { ...v, fromCache: false };
  } finally {
    inflight.delete(key);
  }
}

/**
 * ===== Discord 互動處理 =====
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  await interaction.deferReply();

  const item = interaction.options.getString('item');
  const world = interaction.options.getString('world') || DEFAULT_WORLD;
  // dc 先保留（你要跨 DC 查我可以下一步做），目前查 world 就夠用
  // const dc = interaction.options.getString('dc') || DEFAULT_DC;

  try {
    const r = await queryPrice({ item, world });

    if (!r.ok) {
      if (r.reason === 'not_found') {
        return interaction.editReply(`❌ 找不到物品：**${item}**（請換更完整名字或改用英文）`);
      }
      return interaction.editReply('❌ 查詢失敗，請稍後再試');
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${r.itemName}`)
      .setDescription(`World：**${r.world}**  ｜  Item ID：\`${r.itemId}\``)
      .addFields(
        { name: '最低單價', value: r.lowest ? `${r.lowest.toLocaleString()} Gil` : '（無掛單）', inline: true },
        { name: '平均單價', value: r.avg ? `${r.avg.toLocaleString()} Gil` : '（無資料）', inline: true }
      );

    if (r.lastSale) {
      const ts = r.lastSale.timestamp ? `<t:${r.lastSale.timestamp}:R>` : '';
      embed.addFields({
        name: '最近成交',
        value: `${r.lastSale.pricePerUnit.toLocaleString()} Gil × ${r.lastSale.quantity}  ${ts}`.trim(),
        inline: false
      });
    } else {
      embed.addFields({ name: '最近成交', value: '（無資料）', inline: false });
    }

    const foot = [];
    if (r.fromCache) foot.push('⚡ 快取');
    else foot.push('🌐 即時');
    if (r.sharedInflight) foot.push('併發合併');
    foot.push(`TTL 10 分鐘`);
    embed.setFooter({ text: foot.join(' ｜ ') });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ 查詢失敗，請稍後再試');
  }
});

client.login(process.env.DISCORD_TOKEN);
