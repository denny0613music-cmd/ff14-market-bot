import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, SlashCommandBuilder, Routes, EmbedBuilder } from 'discord.js';
import { REST } from '@discordjs/rest';
import fetch from 'node-fetch';

/**
 * ===== Render Web Service 必須開 Port（保活用）=====
 */
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
  })
  .listen(port, () => {
    console.log(`HTTP server listening on ${port}`);
  });

/**
 * ===== 固定查「陸行鳥（繁中服）」=====
 * Universalis 的 DC 名稱就叫「陸行鳥」
 */
const TCHW_DC = '陸行鳥';

/**
 * ===== 快取 & 併發去重 =====
 */
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分鐘
const cache = new Map(); // key -> { expiresAt, value }
const inflight = new Map(); // key -> Promise

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
 * ===== Discord Client =====
 */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/**
 * ===== Slash 指令：/price item =====
 */
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 繁中服（陸行鳥）市場價格（Universalis）')
  .addStringOption((opt) =>
    opt.setName('item').setDescription('物品名稱（中文/英文都可）').setRequired(true)
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
 * ===== 物品名稱 -> itemId（Universalis marketable v2 search）=====
 */
async function resolveItemIdByName(itemName) {
  const q = itemName.trim();
  const url = `https://universalis.app/api/v2/marketable?search=${encodeURIComponent(q)}&limit=10`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`resolveItemId failed: ${res.status}`);

  const data = await res.json();
  const results = data?.results || [];
  if (!results.length) return null;

  // 優先完全相符（忽略空白/大小寫），否則取第一筆
  const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
  const target = norm(q);

  let best = results.find((r) => norm(r.itemName) === target);
  if (!best) best = results[0];

  return { itemId: best.itemId, itemName: best.itemName || q };
}

/**
 * ===== 查 DC 聚合市場（陸行鳥）=====
 * v2: /api/v2/{dc}/{itemId}
 */
async function fetchDcMarket(dcName, itemId) {
  const url = `https://universalis.app/api/v2/${encodeURIComponent(dcName)}/${itemId}?listings=20&entries=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`market fetch failed: ${res.status}`);
  return res.json();
}

/**
 * ===== 從 DC 資料算出：最低/平均/最近成交 + 最便宜伺服器 =====
 */
function computeStats(dcMarketJson) {
  const listings = Array.isArray(dcMarketJson.listings) ? dcMarketJson.listings : [];
  const history = Array.isArray(dcMarketJson.recentHistory) ? dcMarketJson.recentHistory : [];

  const lowestListing = listings.length ? listings[0] : null;
  const lowest = lowestListing?.pricePerUnit ?? null;
  const cheapestWorld = lowestListing?.worldName || lowestListing?.world || null;

  // 平均價：優先用最近成交 history（最多 20 筆），沒有再用掛單平均
  let avg = null;
  if (history.length) {
    const units = history.map((h) => h.pricePerUnit).filter((n) => Number.isFinite(n));
    if (units.length) avg = Math.round(units.reduce((a, b) => a + b, 0) / units.length);
  } else if (listings.length) {
    const units = listings.map((l) => l.pricePerUnit).filter((n) => Number.isFinite(n));
    if (units.length) avg = Math.round(units.reduce((a, b) => a + b, 0) / units.length);
  }

  // 最近成交（最新一筆）
  let lastSale = null;
  if (history.length) {
    const h = history[0];
    lastSale = {
      pricePerUnit: h.pricePerUnit,
      quantity: h.quantity,
      timestamp: h.timestamp,
    };
  }

  return { lowest, cheapestWorld, avg, lastSale };
}

/**
 * ===== 主查詢：名稱 -> itemId -> 陸行鳥 DC 市場 -> 統計 =====
 */
async function queryTchwPrice(itemName) {
  const key = `tchw:${itemName}`.toLowerCase();

  const cached = getCache(key);
  if (cached) return { ...cached, fromCache: true };

  if (inflight.has(key)) {
    const v = await inflight.get(key);
    return { ...v, fromCache: true, sharedInflight: true };
  }

  const p = (async () => {
    const resolved = await resolveItemIdByName(itemName);
    if (!resolved) return { ok: false, reason: 'not_found' };

    const market = await fetchDcMarket(TCHW_DC, resolved.itemId);
    const stats = computeStats(market);

    const result = {
      ok: true,
      dc: TCHW_DC,
      itemId: resolved.itemId,
      itemName: resolved.itemName || itemName,
      ...stats,
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

  // ✅ 防止 Unknown interaction (10062) 直接把程式炸掉
  try {
    await interaction.deferReply();
  } catch (err) {
    console.warn('⚠️ deferReply failed (likely unknown interaction):', err?.code || err);
    return;
  }

  const item = interaction.options.getString('item');

  try {
    const r = await queryTchwPrice(item);

    if (!r.ok) {
      if (r.reason === 'not_found') {
        return interaction.editReply(`❌ 找不到物品：**${item}**（建議輸入更完整名稱，或改用英文）`);
      }
      return interaction.editReply('❌ 查詢失敗，請稍後再試');
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${r.itemName}`)
      .setDescription(`範圍：**${r.dc}（繁中服）** ｜ Item ID：\`${r.itemId}\``)
      .addFields({
        name: '最低單價（全繁中服）',
        value: r.lowest
          ? `${r.lowest.toLocaleString()} Gil${r.cheapestWorld ? `（最便宜：**${r.cheapestWorld}**）` : ''}`
          : '（無掛單）',
        inline: false,
      })
      .addFields({
        name: '平均單價',
        value: r.avg ? `${r.avg.toLocaleString()} Gil` : '（無資料）',
        inline: true,
      });

    if (r.lastSale) {
      const ts = r.lastSale.timestamp ? `<t:${r.lastSale.timestamp}:R>` : '';
      embed.addFields({
        name: '最近成交',
        value: `${r.lastSale.pricePerUnit.toLocaleString()} Gil × ${r.lastSale.quantity} ${ts}`.trim(),
        inline: true,
      });
    } else {
      embed.addFields({ name: '最近成交', value: '（無資料）', inline: true });
    }

    const foot = [];
    foot.push(r.fromCache ? '⚡ 快取' : '🌐 即時');
    if (r.sharedInflight) foot.push('併發合併');
    foot.push('TTL 10 分鐘');
    embed.setFooter({ text: foot.join(' ｜ ') });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    // editReply 也可能遇到 interaction 過期，避免再炸一次
    try {
      await interaction.editReply('❌ 查詢失敗，請稍後再試');
    } catch (e) {
      console.warn('⚠️ editReply failed:', e?.code || e);
    }
  }
});

/**
 * ✅ 全域防炸：避免任何一次 API/互動錯誤把 bot 弄死
 */
process.on('unhandledRejection', (err) => {
  console.error('❌ unhandledRejection', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException', err);
});
client.on('error', (err) => {
  console.error('❌ client error', err);
});

client.login(process.env.DISCORD_TOKEN);
