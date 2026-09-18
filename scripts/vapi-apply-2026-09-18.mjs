// Applique dans VAPI (live) les changements du 2026-09-18 :
//   - ajoute le champ « address » au tool capture_lead (adresse du projet)
//   - repousse les prompts FR / EN / accueil depuis prompts/*.txt
//     (nouvelle étape « demande l'adresse » ; le reste inchangé)
//
// Le reste de l'enrichissement (recherche du compte client Shopify par téléphone
// et ajout de ses infos au courriel) est côté serveur Ai.js — déjà déployé, rien
// à faire dans VAPI pour ça.
//
// LANCER DEPUIS LA RACINE DU REPO (clé VAPI injectée par Railway) :
//   railway run node scripts/vapi-apply-2026-09-18.mjs
import fs from 'node:fs';
import path from 'node:path';
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const REPO = path.resolve(process.cwd());
const IDS = {
  accueil: '7f9e517e-0432-4d02-ba54-dbc27c368401',
  fr: 'dad1ac9d-5317-4765-8e38-55803ee72f74',
  en: '3f654c21-10fe-4310-985a-61525858e35b',
};
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 600)}`);
  return t ? JSON.parse(t) : null;
}
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
for (const f of ['prompts/prompt-fr.txt', 'prompts/prompt-en.txt', 'prompts/prompt-accueil.txt']) {
  if (!fs.existsSync(path.join(REPO, f))) { console.error('Fichier manquant :', f, '— lancer depuis la racine du repo'); process.exit(2); }
}
const results = [];
const step = async (label, fn) => { try { const r = await fn(); results.push(`OK    ${label}${r ? ' — ' + r : ''}`); } catch (e) { results.push(`ECHEC ${label} — ${e.message}`); } };

// 1. Tool capture_lead : ajouter le paramètre « address »
await step('tool capture_lead + address', async () => {
  const tools = await api('GET', '/tool');
  const tool = tools.find(t => t.function?.name === 'capture_lead');
  if (!tool) throw new Error('tool capture_lead introuvable');
  const fn = tool.function || {};
  const params = fn.parameters || { type: 'object', properties: {}, required: [] };
  const properties = { ...(params.properties || {}) };
  properties.address = {
    type: 'string',
    description: "Adresse où aurait lieu le projet (rue, ville, secteur), telle que dictée par le client. Facultatif.",
  };
  const body = { function: { ...fn, parameters: { ...params, properties } } };
  const r = await api('PATCH', `/tool/${tool.id}`, body);
  return `champs = ${Object.keys(r.function?.parameters?.properties || {}).join(', ')}`;
});

// 2. Repousser les prompts (l'étape adresse est dans les fichiers)
for (const [key, file] of [['FR', 'prompts/prompt-fr.txt'], ['EN', 'prompts/prompt-en.txt'], ['Accueil', 'prompts/prompt-accueil.txt']]) {
  await step(`prompt ${key}`, async () => {
    const id = key === 'FR' ? IDS.fr : key === 'EN' ? IDS.en : IDS.accueil;
    const a = await api('GET', `/assistant/${id}`);
    const r = await api('PATCH', `/assistant/${id}`, {
      model: { ...a.model, messages: [{ role: 'system', content: read(file) }] },
    });
    return `prompt = ${r.model?.messages?.[0]?.content?.length} chars, maj ${r.updatedAt}`;
  });
}

console.log(results.join('\n'));
