import fs from 'node:fs';
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) process.exit(2);
const r = await fetch('https://api.vapi.ai/file', { headers: { Authorization: `Bearer ${KEY}` } });
const files = await r.json();
fs.writeFileSync(process.argv[2] + '/files.json', JSON.stringify(files, null, 1));
const A = JSON.parse(fs.readFileSync(process.argv[2] + '/assistants.json', 'utf8'));
const used = new Set(A.flatMap(a => a.model?.knowledgeBase?.fileIds || []));
for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) console.log(`${used.has(f.id) ? 'KB ' : '-- '} ${f.name}  (${f.bytes} o, maj ${f.updatedAt.slice(0, 10)})`);
console.log(`total fichiers: ${files.length}, utilisés dans KB: ${[...used].length}`);
