// Applique dans VAPI (live) — 2026-10-11 : FERMETURE DE SPA
//   Problème : Barry donnait 119 $ (appel de service) pour une fermeture de spa.
//   1. Ajoute knowledge/fermeture-spa.txt (tarifs Shopify par marque/série, 200 $ à 500 $; spas de nage 460 $ à 650 $)
//   2. Remplace knowledge/appels-de-service.txt (précise que la fermeture de spa n'est PAS un appel de service)
//   3. Repousse les prompts FR + EN (section FERMETURE DE SPA dans les tarifs officiels)
//   L'assistant Accueil et le tool capture_lead ne sont pas touchés.
//
// DEPUIS LA RACINE DU REPO (clé VAPI injectée par Railway) :
//   railway run node scripts/vapi-apply-2026-10-11.mjs
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
const KB_TO_REPLACE = ['appels-de-service.txt', 'fermeture-spa.txt']; // fermeture-spa.txt = nouveau fichier (ajouté)
for (const f of ['prompts/prompt-fr.txt', 'prompts/prompt-en.txt', ...KB_TO_REPLACE.map(n => 'knowledge/' + n)]) {
  if (!fs.existsSync(path.join(REPO, f))) { console.error('Fichier manquant :', f, '— lancer depuis la racine du repo'); process.exit(2); }
}
const results = [];
const step = async (label, fn) => { try { const r = await fn(); results.push(`OK    ${label}${r ? ' — ' + r : ''}`); } catch (e) { results.push(`ECHEC ${label} — ${e.message}`); } };

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
