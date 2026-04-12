import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'loto7-analyser';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// ========== スクレイピング ==========
async function scrape() {
  console.log('Fetching loto7 data...');

  const res = await fetch('https://www.ohtashp.com/topics/takarakuji/loto7/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Loto7Scraper/2.0)' }
  });

  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

  const html = await res.text();
  console.log(`HTML length: ${html.length}`);
  const hasKai = html.includes('第672回') || html.includes('第671回');
  console.log(`Contains 第NNN回: ${hasKai}`);

  const $ = cheerio.load(html);
  console.log(`Tables: ${$('table').length}, TR: ${$('table tr').length}`);

  // デバッグ: 最初のTRのセルを表示
  const firstRow = $('table tr').first();
  const firstCells = firstRow.find('td').map((_, td) => $(td).text().trim()).get();
  console.log('First row cells:', firstCells.slice(0, 5));

  const entries = [];

  // テーブル行を解析
  // 構造: 回別 | 抽選日 | 本数字×7 | bonus×2 | 1等口数 | 当せん金 | キャリーオーバー
  $('table tr').each((_, row) => {
    const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();

    // 「第NNN回」パターンを検出
    const roundMatch = cells[0]?.match(/第(\d+)回/);
    const dateMatch = cells[1]?.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);

    if (!roundMatch || !dateMatch) return;

    const numbers = [];
    const bonuses = [];

    // 本数字: cells[2]〜cells[8]（7個）
    for (let i = 2; i <= 8; i++) {
      const n = parseInt(cells[i]);
      if (n >= 1 && n <= 37) numbers.push(n);
    }

    // ボーナス数字: cells[9]〜cells[10]（2個）
    for (let i = 9; i <= 10; i++) {
      const n = parseInt(cells[i]);
      if (n >= 1 && n <= 37) bonuses.push(n);
    }

    if (numbers.length === 7) {
      entries.push({
        round: parseInt(roundMatch[1]),
        date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
        numbers: numbers.sort((a, b) => a - b),
        bonuses,
      });
    }
  });

  console.log(`Parsed ${entries.length} entries`);
  return entries.sort((a,b) => b.round - a.round);
}

// ========== Firestore保存 ==========
async function saveToFirestore(entry) {
  const docId = `round_${entry.round}`;
  const url = `${FIRESTORE_BASE}/loto7_entries/${docId}?key=${FIREBASE_API_KEY}`;

  const body = {
    fields: {
      round: { integerValue: String(entry.round) },
      date: { stringValue: entry.date },
      numbers: {
        arrayValue: {
          values: entry.numbers.map(n => ({ integerValue: String(n) }))
        }
      },
      bonuses: {
        arrayValue: {
          values: entry.bonuses.map(n => ({ integerValue: String(n) }))
        }
      },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  };

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore error: ${err}`);
  }
}

// ========== メイン ==========
async function main() {
  try {
    const entries = await scrape();

    if (entries.length === 0) {
      console.error('No entries parsed. Check scraping logic.');
      process.exit(1);
    }

    // 最新50件を保存
    const toSave = entries.slice(0, 50);
    let saved = 0;

    for (const entry of toSave) {
      await saveToFirestore(entry);
      saved++;
      console.log(`Saved: 第${entry.round}回 (${entry.date})`);
    }

    console.log(`✅ Done: ${saved} entries saved to Firestore`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
