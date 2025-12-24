import 'dotenv/config';
import http from 'http';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
} from 'discord.js';
import { REST } from '@discordjs/rest';

/* ===============================
   Render HTTP server
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
const ITEMS = [];
let ITEMS_READY = false;

/* ===============================
   載入所有物品（中英）
================================ */
async function loadItems() {
  console.log('⏳ Loading items from XIVAPI...');
  let page = 1;

  while (true) {
    const url = `https://xivapi.com/Item?language=zh&limit=500&page=${page}`;
    const res = await fetch(url);
    const json = await res.json();

    for (const item of json.Results) {
      ITEMS.push({
        id: item.ID,
        zh: item.Name,
        en: item.Name_en
      });
    }

    if (!json.Pagination.PageNext) break;
    page++;
  }

  ITEMS_READY = true;
  console.log(`✅ Loaded ${ITEMS.length} items`);
}

/* ===============================
   模糊搜尋（最多 25）
================================ */
function searchItems(keyword) {
  const key = keyword.toLowerCase();
  return ITEMS.filter(i =>
    i.zh?.includes(keyword) ||
    i.en?.toLowerCase().includes(key)
  ).slice(0, 25);
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
   Commands
================================ */
const priceCmd = new SlashCommandBuilder()
  .setName('price')
  .setDescription('查詢 FF14 市價')
  .addStringOption(opt =>
    opt.setName('item')
      .setDescription('物品名稱')
      .setRequired(true)
  );

const contextCmd = new ContextMenuCommandBuilder()
  .setName('查詢 FF14 市價')
  .setType(ApplicationCommandType.Message);

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
    { body: [priceCmd.toJSON(), contextCmd.toJSON()] }
  );

  console.log('✅ Commands registered');
});

/* ===============================
   Interaction
================================ */
client.on('interactionCreate', async interaction => {
  /* ---------- Slash / Context 共用 ---------- */
  let keyword = null;

  if (interaction.isChatInputCommand() && interaction.commandName === 'price') {
    keyword = interaction.options.getString('item').trim();
  }

  if (interaction.isMessageContextMenuCommand()) {
    keyword = interaction.targetMessage.content.trim();
  }

  if (!keyword) return;

  try {
    await interaction.deferReply();
  } catch {
    return;
  }

  if (!ITEMS_READY) {
    return interaction.editReply('⏳ 物品資料載入中，請稍後再試');
  }

  const matches = searchItems(keyword);

  if (matches.length === 0) {
    return interaction.editReply(`❌ 找不到符合「${keyword}」的物品`);
  }

  /* ---------- 多結果 → 下拉選單 ---------- */
  if (matches.length > 1) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('select_item')
      .setPlaceholder('請選擇物品')
      .addOptions(
        matches.map(i => ({
          label: i.zh,
          description: i.en,
          value: String(i.id)
        }))
      );

    return interaction.editReply({
      content: '🔍 找到多個物品，請選擇：',
      components: [new ActionRowBuilder().addComponents(menu)]
    });
  }

  /* ---------- 單一結果 ---------- */
  await sendPrice(interaction, matches[0]);
});

/* ===============================
   下拉選單
================================ */
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'select_item') return;

  try {
    await interaction.deferUpdate();
  } catch {
    return;
  }

  const itemId = interaction.values[0];
  const item = ITEMS.find(i => String(i.id) === itemId);
  if (!item) return;

  await sendPrice(interaction, item, true);
});

/* ===============================
   發送價格
================================ */
async function sendPrice(interaction, item, isUpdate = false) {
  try {
    const data = await fetchMarket(item.id);
    const prices = data.listings.map(l => l.pricePerUnit);

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${item.zh}`)
      .setDescription(`${item.en}\n資料中心：${DATA_CENTER}`)
      .addFields(
        { name: '最低價', value: `${Math.min(...prices)} Gil`, inline: true },
        {
          name: '平均價',
          value: `${Math.round(prices.reduce((a, b) => a + b) / prices.length)} Gil`,
          inline: true
        }
      )
      .setFooter({ text: '資料來源：Universalis' });

    const payload = { embeds: [embed], components: [] };

    if (isUpdate) {
      await interaction.editReply(payload);
    } else {
      await interaction.editReply(payload);
    }

  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ 查詢失敗');
  }
}

/* ===============================
   Login
================================ */
client.login(process.env.DISCORD_TOKEN);
