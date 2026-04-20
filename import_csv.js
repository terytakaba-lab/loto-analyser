import fetch from 'node-fetch';
import fs from 'fs';
import iconv from 'iconv-lite';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'loto7-analyser';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function parseCSV(buffer) {
  // Shift-JISをUTF-8に変換
  const text = iconv.decode(buffer, 'shift_jis');
  const lines = text.split('\n').filter(l => l.trim());
  const entries = [];

  for (const line of lines) {
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));

    const round = parseInt(cols[0]);
    if (isNaN(round) || round < 1) continue; // ヘッダー行スキップ

    const dateMatch = (cols[1] || '').match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (!dateMatch) continue;

    // 本数字: cols[2]〜cols[8]（7個）
    const numbers = [];
    for (let i = 2; i <= 8; i++) {
      const n = parseInt(cols[i]);
      if (n >= 1 && n <= 37) numbers.push(n);
    }

    // ボーナス数字: cols[9]〜cols[10]（2個）
    const bonuses = [];
    for (let i = 9; i <= 10; i++) {
      const n = parseInt(cols[i]);
      if (n >= 1 && n <= 37) bonuses.push(n);
    }

    // キャリーオーバー: 最終列
    const carryover = parseInt(cols[cols.length - 1]) > 0;
    const month = parseInt(dateMatch[2]);

    if (numbers.length === 7) {
      entries.push({
        round,
        date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
        numbers: numbers.sort((a,b) => a-b),
        bonuses,
        carryover,
        month,
      });
    }
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
      numbers: { arrayValue: { values: entry.numbers.map(n => ({ integerValue: String(n) })) } },
      bonuses: { arrayValue: { values: (entry.bonuses||[]).map(n => ({ integerValue: String(n) })) } },
      carryover: { booleanValue: entry.carryover },
      month: { integerValue: String(entry.month) },
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
  const csvPath = process.argv[2] || 'loto7.csv';

  try {
    const buffer = fs.readFileSync(csvPath);
    const entries = parseCSV(buffer);

    console.log(`Parsed ${entries.length} entries`);
    console.log(`Latest: 第${entries[0]?.round}回 (${entries[0]?.date})`);
    console.log(`Oldest: 第${entries[entries.length-1]?.round}回 (${entries[entries.length-1]?.date})`);

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
