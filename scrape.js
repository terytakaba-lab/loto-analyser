import fetch from 'node-fetch';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'loto7-analyser';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// CSV取得・パース
async function scrapeCSV() {
  console.log('Fetching LOTO7 CSV (all rounds)...');

  // KYO's LOTO7のCSVを使用（全回分）
  const res = await fetch('https://loto7.thekyo.jp/download/LOTO7_ALL.csv', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Loto7Scraper/3.0)' }
  });

  if (!res.ok) {
    // フォールバック: mk-modeのCSV
    console.log('Trying fallback CSV source...');
    return await scrapeMkMode();
  }

  const text = await res.text();
  return parseCSV(text);
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const entries = [];

  for (const line of lines) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));

    // 1列目が回数（数字）かチェック
    const round = parseInt(cols[0]);
    if (isNaN(round) || round < 1) continue;

    // 日付パース
    const dateStr = cols[1];
    const dateMatch = dateStr?.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (!dateMatch) continue;

    // 本数字7個・ボーナス2個を探す
    const numbers = [];
    const bonuses = [];

    // CSV構造を柔軟に対応（列位置が異なる場合）
    for (let i = 2; i < cols.length && numbers.length < 7; i++) {
      const n = parseInt(cols[i]);
      if (n >= 1 && n <= 37) numbers.push(n);
    }

    // ボーナス数字（本数字の後）
    let foundBonus = false;
    for (let i = 2 + numbers.length; i < cols.length && bonuses.length < 2; i++) {
      const n = parseInt(cols[i]);
      if (n >= 1 && n <= 37) { bonuses.push(n); foundBonus = true; }
      else if (foundBonus) break;
    }

    // キャリーオーバー検出
    const rowText = cols.join(',');
    const hasCarryover = cols.some(c => {
      const n = parseInt(c.replace(/,/g, ''));
      return n > 100000000; // 1億以上=キャリーオーバー額
    });

    const month = parseInt(dateMatch[2]);

    if (numbers.length === 7) {
      entries.push({
        round,
        date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
        numbers: numbers.sort((a,b) => a-b),
        bonuses,
        carryover: hasCarryover,
        month,
      });
    }
  }

  console.log(`Parsed ${entries.length} entries from CSV`);
  return entries.sort((a,b) => b.round - a.round);
}

// mk-modeのページからスクレイピング（フォールバック）
async function scrapeMkMode() {
  const entries = [];
  const totalPages = 34; // 672回 / 20件 ≈ 34ページ

  for (let page = 0; page < totalPages; page++) {
    const url = page === 0
      ? 'https://www.mk-mode.com/rails/loto/loto7'
      : `https://www.mk-mode.com/rails/loto/loto7?page_num=${page}`;

    console.log(`Fetching page ${page+1}/${totalPages}...`);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Loto7Scraper/3.0)' }
    });

    if (!res.ok) { console.warn(`Page ${page} failed`); continue; }

    const html = await res.text();

    // テーブル行から抽出
    const rowPattern = /(\d{3,4})\s*\|\s*(\d{4}\/\d{2}\/\d{2})\s*\|\s*\*\*([\d\s]+)\(([\d\s]+)\)\*\*/g;
    let match;
    while ((match = rowPattern.exec(html)) !== null) {
      const round = parseInt(match[1]);
      const dateStr = match[2];
      const numStr = match[3];
      const bonusStr = match[4];

      const numbers = numStr.trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 37);
      const bonuses = bonusStr.trim().split(/\s+/).map(Number).filter(n => n >= 1 && n <= 37);

      if (numbers.length === 7) {
        const dateMatch = dateStr.match(/(\d{4})\/(\d{2})\/(\d{2})/);
        entries.push({
          round,
          date: dateStr,
          numbers: numbers.sort((a,b) => a-b),
          bonuses,
          carryover: false,
          month: parseInt(dateMatch?.[2] || 1),
        });
      }
    }

    // レート制限対策
    await new Promise(r => setTimeout(r, 500));
  }

  return entries.sort((a,b) => b.round - a.round);
}

async function saveToFirestore(entry) {
  const docId = `round_${String(entry.round).padStart(4, '0')}`;
  const url = `${FIRESTORE_BASE}/loto7_entries/${docId}?key=${FIREBASE_API_KEY}`;

  const body = {
    fields: {
      round: { integerValue: String(entry.round) },
      date: { stringValue: entry.date },
      numbers: {
        arrayValue: { values: entry.numbers.map(n => ({ integerValue: String(n) })) }
      },
      bonuses: {
        arrayValue: { values: (entry.bonuses || []).map(n => ({ integerValue: String(n) })) }
      },
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

    console.log(`Saving ${entries.length} entries to Firestore...`);
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
