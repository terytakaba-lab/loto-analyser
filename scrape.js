import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'loto7-analyser';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// CSV直接ダウンロード試行
async function scrapeCSV() {
  const csvUrls = [
    'https://loto7.thekyo.jp/LOTO7_ALL.csv',
    'https://loto-life.net/csv/loto7.csv',
    'https://r7-yosou.hippy.jp/loto7all.csv',
  ];

  for (const url of csvUrls) {
    try {
      console.log(`Trying CSV: ${url}`);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Loto7Scraper/3.0)' }
      });
      if (!res.ok) continue;

      const text = await res.text();
      if (text.length < 1000) continue;

      const entries = parseCSV(text);
      if (entries.length > 100) {
        console.log(`✅ CSV source found: ${url}`);
        return entries;
      }
    } catch(e) {
      console.log(`Failed: ${url} - ${e.message}`);
    }
  }

  // 全CSV失敗時: sougaku.comをスクレイピング（静的HTML）
  console.log('Falling back to sougaku.com scraping...');
  return await scrapeSougaku();
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const entries = [];

  for (const line of lines) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
    const round = parseInt(cols[0]);
    if (isNaN(round) || round < 1 || round > 9999) continue;

    const dateMatch = (cols[1] || '').match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (!dateMatch) continue;

    const numbers = [];
    const bonuses = [];

    for (let i = 2; i < cols.length; i++) {
      const n = parseInt(cols[i]);
      if (n >= 1 && n <= 37) {
        if (numbers.length < 7) numbers.push(n);
        else if (bonuses.length < 2) bonuses.push(n);
      }
    }

    if (numbers.length === 7) {
      entries.push({
        round,
        date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
        numbers: numbers.sort((a,b) => a-b),
        bonuses,
        carryover: false,
        month: parseInt(dateMatch[2]),
      });
    }
  }

  return entries.sort((a,b) => b.round - a.round);
}

// sougaku.comは静的HTMLで全件載ってる
async function scrapeSougaku() {
  console.log('Fetching sougaku.com (static HTML, all rounds)...');
  const res = await fetch('http://sougaku.com/loto7/data/list1/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!res.ok) throw new Error(`sougaku fetch failed: ${res.status}`);

  const html = await res.text();
  console.log(`HTML length: ${html.length}`);

  const $ = cheerio.load(html);
  const entries = [];

  $('tr').each((_, row) => {
    const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (cells.length < 9) return;

    const round = parseInt(cells[0]);
    if (isNaN(round) || round < 1) return;

    const dateMatch = (cells[1] || '').match(/(\d{4})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})/);
    if (!dateMatch) return;

    const numbers = [];
    const bonuses = [];

    for (let i = 2; i <= 8; i++) {
      const n = parseInt(cells[i]);
      if (n >= 1 && n <= 37) numbers.push(n);
    }
    for (let i = 9; i <= 10 && i < cells.length; i++) {
      const n = parseInt(cells[i]);
      if (n >= 1 && n <= 37) bonuses.push(n);
    }

    if (numbers.length === 7) {
      entries.push({
        round,
        date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
        numbers: numbers.sort((a,b) => a-b),
        bonuses,
        carryover: false,
        month: parseInt(dateMatch[2]),
      });
    }
  });

  // sougaku.comが取れない場合は直接テキスト解析
  if (entries.length < 50) {
    console.log('Trying text-based parsing on sougaku...');
    $('tr').each((_, row) => {
      const text = $(row).text().replace(/\s+/g, ' ').trim();
      const roundMatch = text.match(/^(\d{3,4})\s/);
      const dateMatch = text.match(/(\d{4})[\/\.](\d{1,2})[\/\.](\d{1,2})/);
      if (!roundMatch || !dateMatch) return;

      const afterDate = text.slice(text.indexOf(dateMatch[0]) + dateMatch[0].length);
      const nums = [...afterDate.matchAll(/\b(\d{1,2})\b/g)]
        .map(m => parseInt(m[1])).filter(n => n >= 1 && n <= 37);

      if (nums.length >= 7 && !entries.find(e => e.round === parseInt(roundMatch[1]))) {
        entries.push({
          round: parseInt(roundMatch[1]),
          date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
          numbers: nums.slice(0,7).sort((a,b) => a-b),
          bonuses: nums.slice(7,9),
          carryover: false,
          month: parseInt(dateMatch[2]),
        });
      }
    });
  }

  console.log(`Parsed ${entries.length} entries from sougaku.com`);
  return entries.sort((a,b) => b.round - a.round);
}

async function saveToFirestore(entry) {
  const docId = `round_${String(entry.round).padStart(4, '0')}`;
  const url = `${FIRESTORE_BASE}/loto7_entries/${docId}?key=${FIREBASE_API_KEY}`;

  const body = {
    fields: {
      round: { integerValue: String(entry.round) },
      date: { stringValue: entry.date },
      numbers: { arrayValue: { values: entry.numbers.map(n => ({ integerValue: String(n) })) } },
      bonuses: { arrayValue: { values: (entry.bonuses||[]).map(n => ({ integerValue: String(n) })) } },
      carryover: { booleanValue: entry.carryover || false },
      month: { integerValue: String(entry.month || 1) },
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
    throw new Error(`Firestore error for round ${entry.round}: ${err}`);
  }
}

async function main() {
  try {
    const entries = await scrapeCSV();

    if (entries.length === 0) {
      console.error('No entries parsed.');
      process.exit(1);
    }

    console.log(`Saving ${entries.length} entries...`);
    let saved = 0;

    for (const entry of entries) {
      await saveToFirestore(entry);
      saved++;
      if (saved <= 3 || saved % 100 === 0) {
        console.log(`Progress: ${saved}/${entries.length} - 第${entry.round}回 (${entry.date})`);
      }
    }

    console.log(`✅ Done: ${saved} entries saved to Firestore`);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
