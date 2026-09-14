// Récupère les appels VAPI de la semaine passée + la config des assistants.
// La clé vient de process.env.VAPI_PRIVATE_KEY (injectée par `railway run`), jamais affichée.
import fs from 'node:fs';
const KEY = process.env.VAPI_PRIVATE_KEY;
if (!KEY) { console.error('VAPI_PRIVATE_KEY absente'); process.exit(2); }
const OUT = process.argv[2];
const H = { Authorization: `Bearer ${KEY}` };
// Semaine passée : lundi 7 sept 00:00 EDT -> lundi 14 sept 00:00 EDT (UTC-4)
const startISO = '2026-09-07T04:00:00.000Z';
const endISO   = '2026-09-14T04:00:00.000Z';

async function getJSON(url) {
  const r = await fetch(url, { headers: H });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

// Pagination VAPI : limit max 1000, on boucle avec createdAtLt si besoin
let all = [];
let lt = endISO;
for (let i = 0; i < 10; i++) {
  const url = `https://api.vapi.ai/call?createdAtGe=${startISO}&createdAtLt=${lt}&limit=1000`;
  const page = await getJSON(url);
  const arr = Array.isArray(page) ? page : (page.calls || page.results || []);
  all = all.concat(arr);
  if (arr.length < 1000) break;
  lt = arr[arr.length - 1].createdAt;
}
fs.writeFileSync(`${OUT}/calls.json`, JSON.stringify(all, null, 1));
console.log(`calls: ${all.length} (fenêtre ${startISO} -> ${endISO})`);

const assistants = await getJSON('https://api.vapi.ai/assistant');
fs.writeFileSync(`${OUT}/assistants.json`, JSON.stringify(assistants, null, 1));
console.log(`assistants: ${assistants.length} -> ${assistants.map(a => a.name).join(' | ')}`);

try {
  const squads = await getJSON('https://api.vapi.ai/squad');
  fs.writeFileSync(`${OUT}/squads.json`, JSON.stringify(squads, null, 1));
  console.log(`squads: ${squads.length}`);
} catch (e) { console.log('squads: ' + e.message); }
try {
  const tools = await getJSON('https://api.vapi.ai/tool');
  fs.writeFileSync(`${OUT}/tools.json`, JSON.stringify(tools, null, 1));
  console.log(`tools: ${tools.length} -> ${tools.map(t => t.function?.name || t.type).join(' | ')}`);
} catch (e) { console.log('tools: ' + e.message); }
