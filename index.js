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
   Render HTTP Server
================================ */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT);

/* ===============================
   Discord Client
================================ */
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

/* ===============================
   常數
================================ */
const DATA_CENTER = '陸行鳥';
const ITEM_CACHE = new Map();
let ITEMS_READY = false;

/* ===============================
   下載完整物品清單（啟動一次）
================================ */
async function loadItems() {
  console.log('⏳ Loading item list from XIVAPI...');
  let page = 1;

  while (true) {
    const url = `https://xivapi.com/Item?language=zh&limit=500&page=${page}`;
    const res = await fetch(url);
    const json = await res.json();

    for (const item of json.Results) {
      ITEM_CACHE.set(item.ID, {
        id: item.ID,
        zh: item.Name,
        en: item.Name_en
      });
    }

    if (!json.Pagination.PageNext) break;
    page++;
  }

  ITEMS_READY = true;
  console.log(`✅ Loaded ${ITEM_CACHE.size} items`);
}

/* ===============================
   模糊搜尋
================================ */
function searchItem(keyword) {
  const key = keyword.toLowerCase();
  const results = [];

  for (const item of ITEM_CACHE.values()) {
    if (
      item.zh?.includes(keyword) ||
      item.en?.toLowerCase().includes(key)
    ) {
      results.push(item);
      if (results.length >= 5) break;
    }
  }

  return results;
}

/* ===============================
   查 Universalis
================================ */
async function fetchMarket(itemId) {
  const url = `https://universalis.app/api/v2/${DATA_CENTER}/${itemId}?listings=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Universalis error');
  return res.json();
}

/* ===============================
   Slash 指令
================================ */
const command = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 繁中服市價（模糊搜尋）')
  .addStringOption(opt =>
    opt.setName('item')
      .setDescription('物品名稱（可輸入部分）')
      .setRequired(true)
  );

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

/* ===============================
   Ready
================================ */
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await loadItems();

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
   Interaction
================================ */
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'price') return;

  try {
    await interaction.deferReply();
  } catch {
    return;
  }

  if (!ITEMS_READY) {
    return interaction.editReply('⏳ 物品資料尚未載入完成');
  }

  const keyword = interaction.options.getString('item').trim();
  const matches = searchItem(keyword);

  if (matches.length === 0) {
    return interaction.editReply(`❌ 找不到符合「${keyword}」的物品`);
  }

  if (matches.length > 1) {
    const list = matches
      .map(i => `• ${i.zh} / ${i.en}`)
      .join('\n');

    return interaction.editReply({
      content: `🔍 找到多個物品，請輸入更完整名稱：\n${list}`
    });
  }

  const item = matches[0];

  try {
    const data = await fetchMarket(item.id);
    const prices = data.listings.map(l => l.pricePerUnit);

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${item.zh}`)
      .setDescription(`(${item.en})`)
      .addFields(
        { name: '最低價', value: `${Math.min(...prices)} Gil`, inline: true },
        {
          name: '平均價',
          value: `${Math.round(prices.reduce((a, b) => a + b) / prices.length)} Gil`,
          inline: true
        }
      )
      .setFooter({ text: '資料來源：Universalis' });

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ 查詢失敗');
  }
});

/* ===============================
   Login
================================ */
client.login(process.env.DISCORD_TOKEN);
