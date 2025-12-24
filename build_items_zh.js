import fs from 'fs';
import fetch from 'node-fetch';

const OUTPUT = './items_zh.json';
const BASE_URL = 'https://xivapi.com/Item';
const PAGE_SIZE = 500;

async function fetchAllItems() {
  let page = 1;
  let results = {};
  let totalPages = 1;

  console.log('📦 開始抓取 FF14 全物品（繁中）');

  while (page <= totalPages) {
    const url =
      `${BASE_URL}?language=zh&limit=${PAGE_SIZE}&page=${page}` +
      `&columns=ID,Name,Name_en`;

    const res = await fetch(url);
    const json = await res.json();

    totalPages = json.Pagination.PageTotal;

    for (const item of json.Results) {
      if (!item.Name || !item.ID) continue;

      results[item.Name] = {
        id: item.ID,
        en: item.Name_en || ''
      };
    }

    console.log(`✅ 第 ${page}/${totalPages} 頁完成`);
    page++;
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(results, null, 2), 'utf8');
  console.log(`🎉 完成！已產生 ${OUTPUT}`);
}

fetchAllItems().catch(console.error);
