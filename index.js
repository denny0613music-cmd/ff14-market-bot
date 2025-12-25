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
   HTTP SERVER
===================== */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('FF14 Market Bot Alive');
}).listen(PORT);

/* =====================
   Load items
===================== */
const ITEMS_PATH = fs.existsSync('./items_zh_tw.json')
  ? './items_zh_tw.json'
  : './items_zh.json';

const RAW = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));

let ITEMS = [];

/* 🔥 萬用解析（重點） */
if (Array.isArray(RAW)) {
  ITEMS = RAW.map(i => ({
    id: Number(i.id ?? i.ID),
    name:
      i.name ??
      i.Name ??
      i.en ??
      i.zh ??
      ''
  }));
} else {
  ITEMS = Object.entries(RAW).map(([id, name]) => ({
    id: Number(id),
    name: String(name)
  }));
}

console.log(`✅ Loaded ${ITEMS.length} items`);

/* =====================
   Manual zh
===================== */
let ITEMS_MANUAL = {};
if (fs.existsSync('./items_zh_manual.json')) {
  ITEMS_MANUAL = JSON.parse(fs.readFileSync('./items_zh_manual.json', 'utf8'));
}

/* =====================
   Search index
===================== */
function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

const SEARCH_INDEX = ITEMS.map(i => {
  const manual = ITEMS_MANUAL[String(i.id)];
  const finalName = manual || i.name || `ID:${i.id}`;
  return {
    id: i.id,
    key: normalize(finalName),
    raw: finalName
  };
});

function findItems(keyword, limit = 8) {
  const key = normalize(keyword);
  if (!key) return [];

  const exact = SEARCH_INDEX.filter(i => i.key === key);
  if (exact.length) return exact.slice(0, limit);

  const list = SEARCH_INDEX.filter(i => i.key.includes(key));
  return list.slice(0, limit);
}

/* =====================
   Universalis
===================== */
const WORLDS = [
  'Bahamut','Tonberry','Typhon','Kujata','Garuda',
  'Ifrit','Ramuh','Ultima','Valefor','Tiamat','Shinryu'
];

async function fetchPrice(id) {
  let prices = [];
  for (const w of WORLDS) {
    try {
      const r = await fetch(`https://universalis.app/api/${w}/${id}?listings=1`);
      const d = await r.json();
      if (d.listings?.length) prices.push(d.listings[0].pricePerUnit);
    } catch {}
  }
  if (!prices.length) return null;
  return {
    min: Math.min(...prices),
    avg: Math.round(prices.reduce((a,b)=>a+b,0)/prices.length)
  };
}

/* =====================
   Discord
===================== */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const cmd = new SlashCommandBuilder()
  .setName('price')
  .setDescription('FF14 市價查詢')
  .addStringOption(o =>
    o.setName('item').setDescription('物品名稱').setRequired(true)
  );

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
await rest.put(
  Routes.applicationCommands(process.env.CLIENT_ID),
  { body: [cmd.toJSON()] }
);

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'price') return;

  try {
    await i.deferReply({ flags: 0 });

    const q = i.options.getString('item');
    const items = findItems(q);

    if (!items.length) {
      return i.editReply(`❌ 找不到符合「${q}」的物品`);
    }

    if (items.length > 1) {
      return i.editReply(
        '🔎 找到多個物品：\n' +
        items.map((m,n)=>`${n+1}. ${m.raw}`).join('\n')
      );
    }

    const item = items[0];
    const price = await fetchPrice(item.id);
    if (!price) return i.editReply('❌ 沒有市場資料');

    const embed = new EmbedBuilder()
      .setTitle(item.raw)
      .addFields(
        { name:'最低價', value:`${price.min} Gil`, inline:true },
        { name:'平均價', value:`${price.avg} Gil`, inline:true }
      );

    await i.editReply({ embeds:[embed] });

  } catch (e) {
    if (e?.code === 10062) return;
    console.error(e);
    try { await i.editReply('❌ 發生錯誤'); } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);
