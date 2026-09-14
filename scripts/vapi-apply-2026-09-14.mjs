// Applique dans VAPI (live) les changements de la revue du 2026-09-14 :
//   - prompts FR / EN / accueil depuis prompts/*.txt
//   - message d'ouverture court sans offre de texto (accueil), premier message EN généré par le modèle
//   - idleTimeoutSeconds 8 → 20 (FR, EN) et 12 (accueil)
//   - transcriber FR : langue du fallback AssemblyAI en → multi (seules valeurs acceptées : multi, en)
//   - 2 nouveaux fichiers KB (backwash, couvercles de spa) attachés à FR et EN
//   - squad : handoff EN → FR (transfer_to_french) pour les francophones mal routés
//
// LANCER DEPUIS LA RACINE DU REPO (clé VAPI injectée par Railway, jamais affichée) :
//   railway run node scripts/vapi-apply-2026-09-14.mjs
//
// Sauvegardes avant modification : prompts/backup-live-2026-09-14/ et vapi-backup-2026-09-14/.
// Pour revenir en arrière : recoller les prompts de la sauvegarde dans le dashboard VAPI.
import fs from 'node:fs';
import path from 'node:path';
const KEY = process.env.VAPI_PRIVATE_KEY; if (!KEY) { console.error('VAPI_PRIVATE_KEY absente (lancer via `railway run`)'); process.exit(2); }
const REPO = path.resolve(process.cwd());
const IDS = {
  accueil: '7f9e517e-0432-4d02-ba54-dbc27c368401',
  fr: 'dad1ac9d-5317-4765-8e38-55803ee72f74',
  en: '3f654c21-10fe-4310-985a-61525858e35b',
  squad: '9565f7f1-4ec8-4396-b7fc-7070b9e954bb',
};
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function api(method, p, body) {
  const r = await fetch('https://api.vapi.ai' + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status}: ${t.slice(0, 600)}`);
  return t ? JSON.parse(t) : null;
}
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
for (const f of ['prompts/prompt-fr.txt', 'prompts/prompt-en.txt', 'prompts/prompt-accueil.txt', 'knowledge/backwash-lavage-filtreur.txt', 'knowledge/couvercles-de-spa.txt']) {
  if (!fs.existsSync(path.join(REPO, f))) { console.error('Fichier manquant :', f, '— lancer depuis la racine du repo'); process.exit(2); }
}
const results = [];
const step = async (label, fn) => { try { const r = await fn(); results.push(`OK    ${label}${r ? ' — ' + r : ''}`); } catch (e) { results.push(`ECHEC ${label} — ${e.message}`); } };

// 1. Fichiers KB (réutilise un fichier du même nom s'il existe déjà)
const newFileIds = [];
await step('upload KB', async () => {
  const existing = await api('GET', '/file');
  for (const name of ['backwash-lavage-filtreur.txt', 'couvercles-de-spa.txt']) {
    const dup = existing.find(f => f.name === name);
    if (dup) { newFileIds.push(dup.id); continue; }
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(path.join(REPO, 'knowledge', name))], { type: 'text/plain' }), name);
    const r = await fetch('https://api.vapi.ai/file', { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd });
    const t = await r.text();
    if (!r.ok) throw new Error(`upload ${name} HTTP ${r.status}: ${t.slice(0, 300)}`);
    newFileIds.push(JSON.parse(t).id);
  }
  return `${newFileIds.length} fichiers → ${newFileIds.map(i => i.slice(0, 8)).join(', ')}`;
});

// 2. Accueil
await step('assistant Accueil', async () => {
  const a = await api('GET', `/assistant/${IDS.accueil}`);
  const r = await api('PATCH', `/assistant/${IDS.accueil}`, {
    firstMessage: 'Bonjour, ici Barry de Barracouda Piscines et Spas. Comment puis-je vous aider?',
    model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-accueil.txt') }] },
    messagePlan: { ...(a.messagePlan || {}), idleTimeoutSeconds: 12 },
  });
  return `idle=${r.messagePlan?.idleTimeoutSeconds} prompt=${r.model?.messages?.[0]?.content?.length} chars firstMessage="${r.firstMessage}"`;
});

// 3. FR
await step('assistant FR', async () => {
  const a = await api('GET', `/assistant/${IDS.fr}`);
  const kb = a.model.knowledgeBase || {};
  const fileIds = [...new Set([...(kb.fileIds || []), ...newFileIds])];
  const transcriber = { ...a.transcriber };
  if (transcriber.fallbackPlan?.transcribers?.length) {
    // AssemblyAI n'accepte que « multi » ou « en » : « multi » couvre le français (le live était en « en »).
    transcriber.fallbackPlan = { ...transcriber.fallbackPlan, transcribers: transcriber.fallbackPlan.transcribers.map(t => ({ ...t, language: 'multi' })) };
  }
  const r = await api('PATCH', `/assistant/${IDS.fr}`, {
    model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-fr.txt') }], knowledgeBase: { ...kb, fileIds } },
    messagePlan: { ...(a.messagePlan || {}), idleTimeoutSeconds: 20 },
    transcriber,
  });
  return `idle=${r.messagePlan?.idleTimeoutSeconds} prompt=${r.model?.messages?.[0]?.content?.length} chars KB=${r.model?.knowledgeBase?.fileIds?.length} fichiers fallbackLang=${r.transcriber?.fallbackPlan?.transcribers?.[0]?.language}`;
});

// 4. EN
await step('assistant EN', async () => {
  const a = await api('GET', `/assistant/${IDS.en}`);
  const kb = a.model.knowledgeBase || {};
  const fileIds = [...new Set([...(kb.fileIds || []), ...newFileIds])];
  const r = await api('PATCH', `/assistant/${IDS.en}`, {
    firstMessage: 'Hi, this is Barry from Barracuda Pools and Spas. How can I help you today?',
    firstMessageMode: 'assistant-speaks-first-with-model-generated-message',
    model: { ...a.model, messages: [{ role: 'system', content: read('prompts/prompt-en.txt') }], knowledgeBase: { ...kb, fileIds } },
    messagePlan: { ...(a.messagePlan || {}), idleTimeoutSeconds: 20 },
  });
  return `idle=${r.messagePlan?.idleTimeoutSeconds} mode=${r.firstMessageMode} prompt=${r.model?.messages?.[0]?.content?.length} chars KB=${r.model?.knowledgeBase?.fileIds?.length} fichiers`;
});

// 5. Squad : retour EN → FR
await step('squad handoff EN→FR', async () => {
  const s = await api('GET', `/squad/${IDS.squad}`);
  const members = s.members.map(m => {
    const mm = { assistantId: m.assistantId, assistantOverrides: { ...(m.assistantOverrides || {}) } };
    if (m.assistantId === IDS.en) {
      const existing = (mm.assistantOverrides['tools:append'] || []).filter(t => t.function?.name !== 'transfer_to_french');
      mm.assistantOverrides['tools:append'] = [...existing, {
        type: 'handoff', async: false,
        function: { name: 'transfer_to_french' },
        messages: [],
        destinations: [{
          type: 'assistant', assistantId: IDS.fr, assistantName: 'Piscine barracuda FR',
          description: 'Use this destination as soon as the caller speaks French or Québécois French, replies in French, or asks for French ("en français", "French please", "parlez-vous français"). A single French word is enough. Do not answer the request yourself, do not apologize, just transfer.',
        }],
        defaultResult: 'Un instant. ',
      }];
    }
    return mm;
  });
  const r = await api('PATCH', `/squad/${IDS.squad}`, { members });
  const enM = r.members.find(m => m.assistantId === IDS.en);
  return `EN tools:append = ${(enM.assistantOverrides?.['tools:append'] || []).map(t => t.function?.name).join(', ') || '(aucun)'}`;
});

// 6. Vérification
await step('vérification', async () => {
  const out = [];
  for (const [k, id] of Object.entries({ accueil: IDS.accueil, fr: IDS.fr, en: IDS.en })) {
    const a = await api('GET', `/assistant/${id}`);
    out.push(`${k}: idle=${a.messagePlan?.idleTimeoutSeconds}, prompt=${a.model?.messages?.[0]?.content?.length} chars, KB=${a.model?.knowledgeBase?.fileIds?.length ?? '-'}, mode=${a.firstMessageMode || '-'}, maj=${a.updatedAt}`);
  }
  return '\n      ' + out.join('\n      ');
});

console.log(results.join('\n'));
