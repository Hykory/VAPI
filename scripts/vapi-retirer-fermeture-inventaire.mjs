// RETIRE l'annonce « fermés aujourd'hui, mercredi le 28 octobre, pour l'inventaire » ajoutée dans
// VAPI le 28 oct à 9 h 08–9 h 11 (dashboard) :
//   - accueil : premier message statique (dit à TOUS les appels, encore le 29) + note dans le prompt
//   - FR / EN : bloc « FERMETURE EXCEPTIONNELLE / SPECIAL CLOSURE » en tête de prompt
// Les fichiers prompts/*.txt du repo (version du 15 oct) sont exactement le live SANS ces blocs :
// aucune autre modification live n'a été faite depuis (vérifié par diff le 29 oct).
//
// DEPUIS LA RACINE DU REPO :
//   railway run node scripts/vapi-retirer-fermeture-inventaire.mjs
import fs from 'node:fs';
import path from 'node:path';
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const REPO = path.resolve(process.cwd());
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 600)}`);
  return t ? JSON.parse(t) : null;
}
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const PLAN = [
  { k: 'Accueil', id: '7f9e517e-0432-4d02-ba54-dbc27c368401', file: 'prompts/prompt-accueil.txt', firstMessage: 'Bonjour, ici Barry de Barracouda Piscines et Spa. Comment puis-je vous aider?' },
  { k: 'FR', id: 'dad1ac9d-5317-4765-8e38-55803ee72f74', file: 'prompts/prompt-fr.txt' },
  { k: 'EN', id: '3f654c21-10fe-4310-985a-61525858e35b', file: 'prompts/prompt-en.txt' },
];
for (const p of PLAN) if (!fs.existsSync(path.join(REPO, p.file))) { console.error('Fichier manquant :', p.file, '— lancer depuis la racine du repo'); process.exit(2); }
for (const p of PLAN) {
  const content = read(p.file);
  // Garde-fou précis : la FERMETURE d'inventaire, pas le mot « inventaire » (la règle de stock dit « inventaire non suivi »).
  const CLOSURE = /FERMETURE EXCEPTIONNELLE|SPECIAL CLOSURE|28 octobre|October 28|vingt-huit octobre|twenty-eighth|pour l'inventaire|for inventory/i;
  if (CLOSURE.test(content)) { console.log(`ECHEC ${p.k} — le fichier ${p.file} contient encore la fermeture, abandon`); continue; }
  try {
    const a = await api('GET', `/assistant/${p.id}`);
    const body = { model: { ...a.model, messages: [{ role: 'system', content }] } };
    if (p.firstMessage) body.firstMessage = p.firstMessage;
    const r = await api('PATCH', `/assistant/${p.id}`, body);
    const still = CLOSURE.test((r.model?.messages?.[0]?.content || '') + ' ' + (r.firstMessage || ''));
    console.log(`OK    ${p.k} — prompt ${r.model?.messages?.[0]?.content?.length} chars${p.firstMessage ? ` | premier message « ${r.firstMessage} »` : ''} | fermeture ${still ? 'ENCORE PRÉSENTE ✘' : 'retirée ✔'}`);
  } catch (e) { console.log(`ECHEC ${p.k} — ${e.message}`); }
}
