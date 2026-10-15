// Applique dans VAPI (live) les actions du scan du 2026-10-15. Lecture d'abord, puis écritures ciblées.
//
//   1. TRANSFERT CHAUD vers le magasin (819-617-1695) sur transfer_call_to_Human ET transfer_call_to_Human_EN :
//      VAPI garde le client en ligne, sonne le magasin ; si personne ne répond, Barry REPREND la ligne
//      et propose de prendre les coordonnées (fallbackPlan). La destination Mathieu reste inchangée.
//   2. Destination de REPLI du numéro 819-617-4343 → 819-617-1695 (si le squad ou Railway tombe).
//   3. Accueil : « Piscines et Spa » (sans s) dans le premier message et le prompt (fichier du repo).
//   4. Accueil : mots-clés du transcripteur (copiés de FR + EN).
//   5. KB : remplace bublue-robots-nettoyeurs.txt par la version du repo (édits d'août) ; supprime 2 orphelins.
//   6. send_sms : description mise à jour (plus d'offre SMS à l'accueil).
//
// DEPUIS LA RACINE DU REPO (clé VAPI injectée par Railway) :
//   railway run node scripts/vapi-apply-2026-10-15.mjs
// Ajouter --dry pour tout lire sans rien écrire.
import fs from 'node:fs';
import path from 'node:path';
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const DRY = process.argv.includes('--dry');
const REPO = path.resolve(process.cwd());
const IDS = { accueil: '7f9e517e-0432-4d02-ba54-dbc27c368401', fr: 'dad1ac9d-5317-4765-8e38-55803ee72f74', en: '3f654c21-10fe-4310-985a-61525858e35b', number: 'ff12efc0-5939-4ace-a367-8d509059d4f2' };
const STORE = '+18196171695';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  if (DRY && method !== 'GET') { console.log(`   [dry] ${method} ${p} ${JSON.stringify(body).slice(0, 160)}…`); return null; }
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 700)}`);
  return t ? JSON.parse(t) : null;
}
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
for (const f of ['prompts/prompt-accueil.txt', 'knowledge/bublue-robots-nettoyeurs.txt']) if (!fs.existsSync(path.join(REPO, f))) { console.error('Fichier manquant :', f, '— lancer depuis la racine du repo'); process.exit(2); }
const results = [];
const step = async (label, fn) => { try { const r = await fn(); results.push(`OK    ${label}${r ? ' — ' + r : ''}`); } catch (e) { results.push(`ECHEC ${label} — ${e.message}`); } };

const tools = await api('GET', '/tool');

// 1. Transfert chaud vers le magasin
const FALLBACK_FR = "Personne n'est disponible au magasin en ce moment. Je peux prendre vos coordonnées pour qu'un conseiller vous rappelle, ou vous pouvez rappeler plus tard. Qu'est-ce que vous préférez ?";
const FALLBACK_EN = "Nobody is available at the store right now. I can take your contact information so an advisor calls you back, or you can call again later. Which do you prefer?";
for (const [name, fallbackMsg, operatorMsg] of [['transfer_call_to_Human', FALLBACK_FR, "Appel transféré par Barry, l'assistant téléphonique."], ['transfer_call_to_Human_EN', FALLBACK_EN, "Call transferred by Barry, the phone assistant."]]) {
  await step(`transfert chaud — ${name}`, async () => {
    const t = tools.find(x => x.function?.name === name);
    if (!t) throw new Error('tool introuvable');
    const destinations = (t.destinations || []).map(d => {
      if (d.number !== STORE) return d;                                        // Mathieu : inchangé
      const base = { mode: 'warm-transfer-say-message', message: operatorMsg, fallbackPlan: { message: fallbackMsg, endCallEnabled: false } };
      return { ...d, transferPlan: base };
    });
    const body = { function: t.function, messages: t.messages, destinations };
    if (DRY) { await api('PATCH', `/tool/${t.id}`, body); return 'dry'; }
    // Essai 1 : avec un délai de 22 s (sous les 25 s de sonnerie Twilio → Barry reprend avant la boîte vocale).
    try {
      const withTimeout = { ...body, destinations: destinations.map(d => d.number === STORE ? { ...d, transferPlan: { ...d.transferPlan, timeout: 22 } } : d) };
      const r = await api('PATCH', `/tool/${t.id}`, withTimeout);
      const s = r.destinations.find(d => d.number === STORE)?.transferPlan;
      return `mode=${s?.mode} timeout=${s?.timeout ?? '(non supporté)'} repli=${s?.fallbackPlan ? 'oui' : 'non'}`;
    } catch (e) {
      if (!/timeout/i.test(e.message)) throw e;
      const r = await api('PATCH', `/tool/${t.id}`, body);                   // Essai 2 : sans timeout
      const s = r.destinations.find(d => d.number === STORE)?.transferPlan;
      return `mode=${s?.mode} (champ timeout refusé par VAPI → délai par défaut) repli=${s?.fallbackPlan ? 'oui' : 'non'}`;
    }
  });
}

// 2. Repli du numéro
await step('repli du numéro 819-617-4343', async () => {
  const r = await api('PATCH', `/phone-number/${IDS.number}`, { fallbackDestination: { type: 'number', number: STORE, message: 'Un instant, je vous transfère au magasin.' } });
  return DRY ? 'dry' : `fallback = ${r.fallbackDestination?.number}`;
});

// 3 + 4. Accueil : Spa + prompt + mots-clés
await step('accueil : premier message + prompt « Piscines et Spa »', async () => {
  const a = await api('GET', `/assistant/${IDS.accueil}`);
  const r = await api('PATCH', `/assistant/${IDS.accueil}`, {
    firstMessage: 'Bonjour, ici Barry de Barracouda Piscines et Spa. Comment puis-je vous aider?',
    model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-accueil.txt') }] },
  });
  return DRY ? 'dry' : `« ${r.firstMessage} » prompt ${r.model?.messages?.[0]?.content?.length} chars`;
});
await step('accueil : mots-clés du transcripteur', async () => {
  const [a, fr, en] = await Promise.all([api('GET', `/assistant/${IDS.accueil}`), api('GET', `/assistant/${IDS.fr}`), api('GET', `/assistant/${IDS.en}`)]);
  const keyterm = [...new Set([...(fr.transcriber?.keyterm || []), ...(en.transcriber?.keyterm || []), 'Barracouda', 'fermeture', 'ouverture', 'Mathieu', 'représentant', 'conseiller'])];
  try {
    const r = await api('PATCH', `/assistant/${IDS.accueil}`, { transcriber: { ...a.transcriber, keyterm } });
    return DRY ? 'dry' : `${(r.transcriber?.keyterm || []).length} mots-clés sur ${r.transcriber?.model}`;
  } catch (e) {
    if (/keyterm/i.test(e.message)) return 'ce transcripteur (flux) refuse les mots-clés — ignoré, rien de cassé';
    throw e;
  }
});

// 5. KB : bublue (repo) + orphelins
await step('KB : bublue-robots-nettoyeurs.txt (version du repo) + orphelins', async () => {
  const files = await api('GET', '/file');
  const [fr, en] = await Promise.all([api('GET', `/assistant/${IDS.fr}`), api('GET', `/assistant/${IDS.en}`)]);
  const refIds = new Set([...(fr.model?.knowledgeBase?.fileIds || []), ...(en.model?.knowledgeBase?.fileIds || [])]);
  const idToName = Object.fromEntries(files.map(f => [f.id, f.name]));
  const oldBublue = (fr.model?.knowledgeBase?.fileIds || []).find(id => idToName[id] === 'bublue-robots-nettoyeurs.txt') || null;
  let newId = null;
  if (!DRY) {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(path.join(REPO, 'knowledge', 'bublue-robots-nettoyeurs.txt'))], { type: 'text/plain' }), 'bublue-robots-nettoyeurs.txt');
    const r = await fetch('https://api.vapi.ai/file', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd });
    const t = await r.text(); if (!r.ok) throw new Error(`upload HTTP ${r.status}: ${t.slice(0, 200)}`);
    newId = JSON.parse(t).id;
    for (const a of [fr, en]) {
      const kb = a.model.knowledgeBase || {};
      let ids = (kb.fileIds || []).map(id => (id === oldBublue ? newId : id)); if (!ids.includes(newId)) ids.push(newId);
      await api('PATCH', `/assistant/${a.id}`, { model: { ...a.model, knowledgeBase: { ...kb, fileIds: [...new Set(ids)] } } });
    }
  }
  const orphans = files.filter(f => !refIds.has(f.id) && f.id !== newId && f.id !== oldBublue);
  const deleted = [];
  for (const id of [oldBublue, ...orphans.map(o => o.id)].filter(Boolean)) {
    try { await api('DELETE', `/file/${id}`); deleted.push(`${idToName[id]}`); } catch (e) { deleted.push(`${idToName[id]}:échec`); }
  }
  return DRY ? `dry (orphelins : ${orphans.map(o => o.name).join(', ') || 'aucun'})` : `bublue ${oldBublue?.slice(0, 8) || '∅'} → ${newId.slice(0, 8)} ; supprimés : ${deleted.join(', ') || 'aucun'}`;
});

// 6. send_sms : description
await step('send_sms : description', async () => {
  const t = tools.find(x => x.function?.name === 'send_sms');
  if (!t) throw new Error('tool introuvable');
  const r = await api('PATCH', `/tool/${t.id}`, {
    function: { ...t.function, description: "Envoie un SMS au client sur le numéro d'où il appelle. À utiliser seulement quand le client demande ou accepte clairement de recevoir une information par texto (lien de suivi, infos produit, récapitulatif). Jamais à l'accueil." },
    server: t.server,
  });
  return DRY ? 'dry' : `maj ${r.updatedAt?.slice(0, 16)} | server ${r.server?.url ? 'OK' : 'MANQUANT ✘'}`;
});

// 7. Vérification
await step('vérification', async () => {
  const [t2, n, a] = await Promise.all([api('GET', '/tool'), api('GET', `/phone-number/${IDS.number}`), api('GET', `/assistant/${IDS.accueil}`)]);
  const out = [];
  for (const name of ['transfer_call_to_Human', 'transfer_call_to_Human_EN']) { const t = t2.find(x => x.function?.name === name); const s = t?.destinations?.find(d => d.number === STORE)?.transferPlan; out.push(`${name}: magasin=${s?.mode}${s?.timeout ? ' ' + s.timeout + 's' : ''} repli=${s?.fallbackPlan ? 'oui' : 'non'} | Mathieu=${t?.destinations?.find(d => d.number !== STORE)?.transferPlan?.mode}`); }
  out.push(`numéro: fallback=${n.fallbackDestination?.number || 'AUCUN'}`);
  out.push(`accueil: « ${a.firstMessage} » keyterms=${(a.transcriber?.keyterm || []).length}`);
  for (const name of ['capture_lead', 'search_shopify_products', 'search_shopify_orders', 'send_sms']) { const t = t2.find(x => x.function?.name === name); out.push(`${name}: server ${t?.server?.url ? 'OK' : 'MANQUANT ✘'}`); }
  return '\n      ' + out.join('\n      ');
});

console.log(results.join('\n'));
