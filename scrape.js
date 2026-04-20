import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'loto7-analyser';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function scrape() {
  console.log('Fetching loto7 data (all rounds)...');

  const res = await fetch('https://www.ohtashp.com/topics/takarakuji/loto7/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });

  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

  const html = await res.text();
  console.log(`HTML length: ${html.length}`);

  const $ = cheerio.load(html);
  const entries = [];

  $('tr').each((_, row) => {
    const text = $(row).text().replace(/\s+/g, ' ').trim();
    const roundMatch = text.match(/第(\d+)回/);
    const dateMatch = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);

    if (!roundMatch || !dateMatch) return;

    const dateStr = dateMatch[0];
    const afterDate = text.slice(text.indexOf(dateStr) + dateStr.length);
    const allNums = [...afterDate.matchAll(/\b(\d{1,2})\b/g)]
      .map(m => parseInt(m[1]))
      .filter(n => n >= 1 && n <= 37);

    if (entries.length < 3) {
      console.log(`Row: round=${roundMatch[1]}, date=${dateStr}, nums=${allNums.join(',')}`);
    }

    if (allNums.length >= 7) {
      // キャリーオーバー検出
      const hasCarryover = text.includes('キャリー') || afterDate.includes('億');
      // 抽選月
      const month = parseInt(dateMatch[2]);

      entries.push({
        round: parseInt(roundMatch[1]),
        date: `${dateMatch[1]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[3]).padStart(2,'0')}`,
        numbers: allNums.slice(0, 7).sort((a, b) => a - b),
        bonuses: allNums.slice(7, 9),
        carryover: hasCarryover,
        month,
      });
    }
  });

  console.log(`Parsed ${entries.length} entries`);
  return entries.sort((a, b) => b.round - a.round);
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
  try {
    const entries = await scrape();

    if (entries.length === 0) {
      console.error('No entries parsed. Check scraping logic.');
      process.exit(1);
    }

    console.log(`Saving all ${entries.length} entries to Firestore...`);
    let saved = 0;

    for (const entry of entries) {
      await saveToFirestore(entry);
      saved++;
      if (saved <= 3 || saved % 50 === 0) {
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
