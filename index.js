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
   HTTP SERVER（Render 必要：一定要先開）
===================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('FF14 Market Bot Alive');
}).listen(PORT, () => {
  console.log(`HTTP server listening on ${PORT}`);
});

/* =====================
   Load items（萬用解析）
===================== */
const ITEMS_PATH = fs.existsSync('./items_zh_tw.json')
  ? './items_zh_tw.json'
  : './items_zh.json';

const RAW = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));

let ITEMS = [];
if (Array.isArray(RAW)) {
  ITEMS = RAW.map(i => ({
    id: Number(i.id ?? i.ID),
    name: (i.name ?? i.Name ?? i.en ?? i.zh ?? '').toString()
  }));
} else {
  ITEMS = Object.entries(RAW).map(([id, name]) => ({
    id: Number(id),
    name: String(name)
  }));
}

console.log(`✅ Loaded ${ITEMS.length} items from ${ITEMS_PATH}`);

/* =====================
   Manual zh dict（可選）
===================== */
let ITEMS_MANUAL = {};
try {
  if (fs.existsSync('./items_zh_manual.json')) {
    ITEMS_MANUAL = JSON.parse(fs.readFileSync('./items_zh_manual.json', 'utf8'));
    console.log(`🧩 Manual dict loaded: ${Object.keys(ITEMS_MANUAL).length} items`);
  } else {
    console.log('⚠️ items_zh_manual.json not found');
  }
} catch {
  console.log('⚠️ items_zh_manual.json invalid JSON');
  ITEMS_MANUAL = {};
}

/* =====================
   Search index
===================== */
function normalize(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/　/g, '');
}

const SEARCH_INDEX = ITEMS.map(i => {
  const manual = ITEMS_MANUAL[String(i.id)];
  const finalName = manual || i.name || `ID:${i.id}`;
  return { id: i.id, key: normalize(finalName), raw: finalName };
});

function findItems(keyword, limit = 8) {
  const key = normalize(keyword);
  if (!key) return [];

  const exact = SEARCH_INDEX.filter(x => x.key === key);
  if (exact.length) return exact.slice(0, limit);

  const prefix = SEARCH_INDEX.filter(x => x.key.startsWith(key));
  const contains = SEARCH_INDEX.filter(x => x.key.includes(key));

  const merged = [];
  const seen = new Set();
  for (const it of [...prefix, ...contains]) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    merged.push(it);
    if (merged.length >= limit) break;
  }
  return merged;
}

/* =====================
   Universalis
===================== */
const WORLDS = [
  'Bahamut','Tonberry','Typhon','Kujata','Garuda',
  'Ifrit','Ramuh','Ultima','Valefor','Tiamat','Shinryu'
];

async function fetchPrice(itemId) {
  let prices = [];
  let lastSales = [];

  for (const w of WORLDS) {
    try {
      const res = await fetch(`https://universalis.app/api/${w}/${itemId}?listings=1&entries=1`);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.listings?.length) prices.push(data.listings[0].pricePerUnit);
      if (data.recentHistory?.length) lastSales.push(data.recentHistory[0].pricePerUnit);
    } catch {}
  }

  if (!prices.length) return null;

  return {
    min: Math.min(...prices),
    avg: Math.round(prices.reduce((a,b)=>a+b,0) / prices.length),
    last: lastSales[0] || prices[0]
  };
}

/* =====================
   Discord setup
===================== */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 繁中服市價（支援繁中/英文）')
  .addStringOption(o =>
    o.setName('item').setDescription('物品名稱').setRequired(true)
  );

async function registerCommands() {
  console.log('🛠 Registering slash commands...');
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID),
    { body: [command.toJSON()] }
  );
  console.log('✅ Slash command registered');
}

client.once('ready', async () => {
  console.log(`🤖 Bot ready: ${client.user?.tag}`);

  try {
    await registerCommands();
  } catch (e) {
    console.error('❌ Slash command register failed:', e);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  try {
    // 公開回覆 flags: 0；想要只有自己看到改成 MessageFlags.Ephemeral
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 0 });
    }

    const keyword = interaction.options.getString('item');
    const matches = findItems(keyword, 8);

    if (!matches.length) {
      return interaction.editReply(`❌ 找不到符合「${keyword}」的物品`);
    }

    if (matches.length > 1) {
      const list = matches.map((m, i) => `${i + 1}. ${m.raw} (ID:${m.id})`).join('\n');
      return interaction.editReply(`🔎 找到多個物品，請輸入更完整名稱：\n${list}`);
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
      );

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    if (err?.code === 10062) return;
    console.error('⚠️ interaction error:', err);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('❌ 查詢失敗，請再試一次');
      } else {
        await interaction.reply({ content: '❌ 查詢失敗，請再試一次', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
});

/* =====================
   Login
===================== */
console.log('🤖 Bot logging in...');
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('❌ Discord login failed:', e);
});
