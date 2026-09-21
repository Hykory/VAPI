// Applique dans VAPI (live) tout ce qui est en attente au 2026-09-21 :
//   1. Tool capture_lead : champ « address » (adresse du projet)
//   2. Prompts FR / EN / accueil repoussés depuis prompts/*.txt
//      (incluant : Barry demande l'adresse ; PISCINES HORS TERRE = ni vente ni installation)
//   3. Remplace 2 fichiers de la base de connaissances par leur version corrigée
//      (services.txt, company-positioning-inground-pools.txt) : téléverse la nouvelle
//      version, repointe les assistants FR + EN dessus, supprime l'ancienne.
//
// Ce script REMPLACE les scripts vapi-apply-2026-09-14 et -09-18 (il refait tout,
// de façon idempotente pour les prompts et le tool). Lancer UNE fois.
//
// DEPUIS LA RACINE DU REPO (clé VAPI injectée par Railway) :
//   railway run node scripts/vapi-apply-2026-09-21.mjs
import fs from 'node:fs';
import path from 'node:path';
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const REPO = path.resolve(process.cwd());
const IDS = { accueil: '7f9e517e-0432-4d02-ba54-dbc27c368401', fr: 'dad1ac9d-5317-4765-8e38-55803ee72f74', en: '3f654c21-10fe-4310-985a-61525858e35b' };
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 600)}`);
  return t ? JSON.parse(t) : null;
}
async function uploadFile(name) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(REPO, 'knowledge', name))], { type: 'text/plain' }), name);
  const r = await fetch('https://api.vapi.ai/file', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd });
  const t = await r.text();
  if (!r.ok) throw new Error(`upload ${name} HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t).id;
}
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const KB_TO_REPLACE = ['services.txt', 'company-positioning-inground-pools.txt'];
for (const f of ['prompts/prompt-fr.txt', 'prompts/prompt-en.txt', 'prompts/prompt-accueil.txt', ...KB_TO_REPLACE.map(n => 'knowledge/' + n)]) {
  if (!fs.existsSync(path.join(REPO, f))) { console.error('Fichier manquant :', f, '— lancer depuis la racine du repo'); process.exit(2); }
}
const results = [];
const step = async (label, fn) => { try { const r = await fn(); results.push(`OK    ${label}${r ? ' — ' + r : ''}`); } catch (e) { results.push(`ECHEC ${label} — ${e.message}`); } };

// 1. Tool capture_lead : champ address
await step('tool capture_lead + address', async () => {
  const tools = await api('GET', '/tool');
  const tool = tools.find(t => t.function?.name === 'capture_lead');
  if (!tool) throw new Error('tool capture_lead introuvable');
  const fn = tool.function || {};
  const params = fn.parameters || { type: 'object', properties: {}, required: [] };
  const properties = { ...(params.properties || {}) };
  properties.address = { type: 'string', description: "Adresse où aurait lieu le projet (rue, ville, secteur), telle que dictée par le client. Facultatif." };
  const r = await api('PATCH', `/tool/${tool.id}`, { function: { ...fn, parameters: { ...params, properties } } });
  return `champs = ${Object.keys(r.function?.parameters?.properties || {}).join(', ')}`;
});

// 2. Remplacer les fichiers KB : téléverser les nouvelles versions
const swaps = [];   // { name, oldId, newId }
const oldToDelete = [];
await step('téléversement KB corrigés', async () => {
  const files = await api('GET', '/file');
  const idToName = Object.fromEntries(files.map(f => [f.id, f.name]));
  const fr = await api('GET', `/assistant/${IDS.fr}`);
  const frIds = fr.model?.knowledgeBase?.fileIds || [];
  for (const name of KB_TO_REPLACE) {
    const oldId = frIds.find(id => idToName[id] === name) || null;
    const newId = await uploadFile(name);
    swaps.push({ name, oldId, newId });
    if (oldId && oldId !== newId) oldToDelete.push(oldId);
  }
  return swaps.map(s => `${s.name}: ${s.oldId ? s.oldId.slice(0, 8) : '(absent)'} → ${s.newId.slice(0, 8)}`).join(' | ');
});
const remap = ids => {
  let out = [...ids];
  for (const s of swaps) {
    if (s.oldId) out = out.map(id => (id === s.oldId ? s.newId : id));
    if (!out.includes(s.newId)) out.push(s.newId);
  }
  return [...new Set(out)];
};

// 3. FR : prompt + KB repointée, en un seul PATCH
await step('assistant FR (prompt + KB)', async () => {
  const a = await api('GET', `/assistant/${IDS.fr}`);
  const kb = a.model.knowledgeBase || {};
  const r = await api('PATCH', `/assistant/${IDS.fr}`, {
    model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-fr.txt') }], knowledgeBase: { ...kb, fileIds: remap(kb.fileIds || []) } },
  });
  return `prompt ${r.model?.messages?.[0]?.content?.length} chars, KB ${r.model?.knowledgeBase?.fileIds?.length} fichiers`;
});

// 4. EN : prompt + KB repointée
await step('assistant EN (prompt + KB)', async () => {
  const a = await api('GET', `/assistant/${IDS.en}`);
  const kb = a.model.knowledgeBase || {};
  const r = await api('PATCH', `/assistant/${IDS.en}`, {
    model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-en.txt') }], knowledgeBase: { ...kb, fileIds: remap(kb.fileIds || []) } },
  });
  return `prompt ${r.model?.messages?.[0]?.content?.length} chars, KB ${r.model?.knowledgeBase?.fileIds?.length} fichiers`;
});

// 5. Accueil : prompt seul (pas de KB)
await step('assistant Accueil (prompt)', async () => {
  const a = await api('GET', `/assistant/${IDS.accueil}`);
  const r = await api('PATCH', `/assistant/${IDS.accueil}`, { model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-accueil.txt') }] } });
  return `prompt ${r.model?.messages?.[0]?.content?.length} chars`;
});

// 6. Supprimer les anciens fichiers KB (best-effort, après repointage)
await step('suppression anciens fichiers KB', async () => {
  const done = [];
  for (const id of oldToDelete) {
    try { await api('DELETE', `/file/${id}`); done.push(id.slice(0, 8)); }
    catch (e) { done.push(`${id.slice(0, 8)}:échec(${e.message.slice(0, 40)})`); }
  }
  return done.join(', ') || '(aucun)';
});

// 7. Vérification
await step('vérification', async () => {
  const out = [];
  for (const [k, id] of Object.entries({ accueil: IDS.accueil, fr: IDS.fr, en: IDS.en })) {
    const a = await api('GET', `/assistant/${id}`);
    out.push(`${k}: prompt=${a.model?.messages?.[0]?.content?.length}, KB=${a.model?.knowledgeBase?.fileIds?.length ?? '-'}, maj=${a.updatedAt}`);
  }
  return '\n      ' + out.join('\n      ');
});

console.log(results.join('\n'));
