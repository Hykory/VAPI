import fs from 'node:fs';
const D = process.argv[2];
const calls = JSON.parse(fs.readFileSync(`${D}/calls.json`, 'utf8'));
const assistants = JSON.parse(fs.readFileSync(`${D}/assistants.json`, 'utf8'));
const squads = JSON.parse(fs.readFileSync(`${D}/squads.json`, 'utf8'));
const tools = JSON.parse(fs.readFileSync(`${D}/tools.json`, 'utf8'));
const aName = Object.fromEntries(assistants.map(a => [a.id, a.name]));

const fmtEDT = iso => new Date(iso).toLocaleString('fr-CA', { timeZone: 'America/Toronto', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dur = c => (c.startedAt && c.endedAt) ? Math.round((new Date(c.endedAt) - new Date(c.startedAt)) / 1000) : 0;
const mask = n => n ? n.replace(/^(\+1\d{3})\d{3}(\d{4})$/, '$1***$2') : '?';

console.log('== KEYS d un appel ==\n' + Object.keys(calls[0]).join(', '));
const msgRoles = {};
for (const c of calls) for (const m of (c.messages || c.artifact?.messages || [])) msgRoles[m.role] = (msgRoles[m.role] || 0) + 1;
console.log('== roles messages ==', JSON.stringify(msgRoles));

// ---- STATS ----
const S = { total: calls.length, byEnded: {}, byDay: {}, byHour: {}, byType: {}, byStatus: {}, durBuckets: { '<15s': 0, '15-30s': 0, '30-60s': 0, '1-2m': 0, '2-5m': 0, '>5m': 0 }, cost: 0, tools: {}, transfers: 0, byFirstAssistant: {}, byAssistantsInvolved: {}, success: {} };
const durs = [];
for (const c of calls) {
  const d = dur(c); durs.push(d);
  S.cost += c.cost || 0;
  S.byEnded[c.endedReason || '?'] = (S.byEnded[c.endedReason || '?'] || 0) + 1;
  S.byType[c.type || '?'] = (S.byType[c.type || '?'] || 0) + 1;
  S.byStatus[c.status || '?'] = (S.byStatus[c.status || '?'] || 0) + 1;
  const day = new Date(c.startedAt || c.createdAt).toLocaleDateString('fr-CA', { timeZone: 'America/Toronto', weekday: 'short', day: '2-digit' });
  S.byDay[day] = (S.byDay[day] || 0) + 1;
  const hr = new Date(c.startedAt || c.createdAt).toLocaleString('fr-CA', { timeZone: 'America/Toronto', hour: '2-digit', hour12: false });
  S.byHour[hr] = (S.byHour[hr] || 0) + 1;
  const b = d < 15 ? '<15s' : d < 30 ? '15-30s' : d < 60 ? '30-60s' : d < 120 ? '1-2m' : d < 300 ? '2-5m' : '>5m';
  S.durBuckets[b]++;
  if (/forward|transfer/i.test(c.endedReason || '')) S.transfers++;
  const first = aName[c.assistantId] || (c.squadId ? 'squad' : c.assistantId || '?');
  S.byFirstAssistant[first] = (S.byFirstAssistant[first] || 0) + 1;
  const msgs = c.messages || c.artifact?.messages || [];
  const involved = new Set();
  for (const m of msgs) {
    if (m.role === 'tool_calls') for (const tc of (m.toolCalls || [])) { const n = tc.function?.name || '?'; S.tools[n] = (S.tools[n] || 0) + 1; }
    if (m.assistantId) involved.add(aName[m.assistantId] || m.assistantId);
  }
  const inv = [...involved].join(' > ') || first;
  S.byAssistantsInvolved[inv] = (S.byAssistantsInvolved[inv] || 0) + 1;
  const se = c.analysis?.successEvaluation; S.success[String(se)] = (S.success[String(se)] || 0) + 1;
}
durs.sort((a, b) => a - b);
S.avgDur = Math.round(durs.reduce((a, b) => a + b, 0) / durs.length);
S.medianDur = durs[Math.floor(durs.length / 2)];
S.totalMin = Math.round(durs.reduce((a, b) => a + b, 0) / 60);
S.cost = +S.cost.toFixed(2);
console.log('== STATS ==\n' + JSON.stringify(S, null, 1));

// ---- TRANSCRIPTS ----
const sorted = [...calls].sort((a, b) => new Date(a.startedAt || a.createdAt) - new Date(b.startedAt || b.createdAt));
let out = '';
let idx = 0;
for (const c of sorted) {
  idx++;
  const msgs = (c.messages || c.artifact?.messages || []).filter(m => m.role !== 'system');
  out += `\n\n######## APPEL ${idx}/${calls.length} — id ${c.id.slice(0, 8)} — ${fmtEDT(c.startedAt || c.createdAt)} — ${dur(c)}s — fin: ${c.endedReason} — de ${mask(c.customer?.number)} — cout ${(c.cost || 0).toFixed(2)}$\n`;
  if (c.analysis?.summary) out += `[resume VAPI] ${c.analysis.summary}\n`;
  if (c.analysis?.successEvaluation !== undefined) out += `[succes VAPI] ${c.analysis.successEvaluation}\n`;
  let lastA = null;
  for (const m of msgs) {
    const who = m.assistantId ? (aName[m.assistantId] || m.assistantId.slice(0, 8)) : null;
    if (who && who !== lastA) { out += `  --- [${who}] ---\n`; lastA = who; }
    const t = (m.secondsFromStart !== undefined) ? `${Math.round(m.secondsFromStart)}s` : '';
    if (m.role === 'user') out += `  CLIENT ${t}: ${m.message}\n`;
    else if (m.role === 'bot' || m.role === 'assistant') out += `  BARRY ${t}: ${m.message}\n`;
    else if (m.role === 'tool_calls') for (const tc of (m.toolCalls || [])) out += `  >> TOOL ${tc.function?.name}(${(tc.function?.arguments || '').toString().slice(0, 300)})\n`;
    else if (m.role === 'tool_call_result') out += `  << RESULT ${(m.name || '')}: ${String(m.result || '').replace(/\s+/g, ' ').slice(0, 400)}\n`;
    else out += `  [${m.role}] ${(m.message || JSON.stringify(m)).toString().slice(0, 200)}\n`;
  }
  if (!msgs.length && c.transcript) out += c.transcript + '\n';
}
fs.writeFileSync(`${D}/transcripts.txt`, out);
console.log(`transcripts.txt: ${out.length} chars`);

// ---- LIVE CONFIG ----
for (const a of assistants) {
  const sys = (a.model?.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n---\n');
  const safe = a.name.replace(/[^a-z0-9]/gi, '_');
  fs.writeFileSync(`${D}/live-prompt-${safe}.txt`, sys);
  console.log(`\n== ASSISTANT ${a.name} (${a.id}) ==`);
  console.log(` model: ${a.model?.provider}/${a.model?.model} url=${a.model?.url || ''} temp=${a.model?.temperature} maxTokens=${a.model?.maxTokens}`);
  console.log(` voice: ${a.voice?.provider}/${a.voice?.model} id=${a.voice?.voiceId} speed=${a.voice?.speed}`);
  console.log(` transcriber: ${JSON.stringify(a.transcriber)}`);
  console.log(` firstMessage: ${a.firstMessage} | mode=${a.firstMessageMode}`);
  console.log(` toolIds: ${(a.model?.toolIds || []).map(id => tools.find(t => t.id === id)?.function?.name || id).join(', ')}`);
  console.log(` inline tools: ${(a.model?.tools || []).map(t => t.type + ':' + (t.function?.name || '')).join(', ')}`);
  console.log(` knowledgeBase: ${JSON.stringify(a.model?.knowledgeBase || a.model?.knowledgeBaseId || null).slice(0, 300)}`);
  console.log(` silenceTimeout=${a.silenceTimeoutSeconds} maxDuration=${a.maxDurationSeconds} endCallMsg=${a.endCallMessage} voicemailDetection=${JSON.stringify(a.voicemailDetection || null).slice(0, 120)}`);
  console.log(` startSpeakingPlan=${JSON.stringify(a.startSpeakingPlan || null)} stopSpeakingPlan=${JSON.stringify(a.stopSpeakingPlan || null)}`);
  console.log(` backgroundSound=${a.backgroundSound} serverUrl=${a.server?.url || a.serverUrl || ''} analysisPlan=${JSON.stringify(a.analysisPlan || null).slice(0, 200)}`);
  console.log(` system prompt: ${sys.length} chars, updated ${a.updatedAt}`);
}
console.log('\n== SQUAD ==');
for (const s of squads) {
  console.log(` ${s.name} (${s.id})`);
  for (const m of s.members) {
    console.log(`  member ${aName[m.assistantId] || m.assistantId}: destinations=${JSON.stringify((m.assistantDestinations || []).map(d => ({ to: d.assistantName, msg: d.message, desc: (d.description || '').slice(0, 120) })))}`);
    if (m.assistantOverrides) console.log(`   overrides: ${JSON.stringify(m.assistantOverrides).slice(0, 400)}`);
  }
}
console.log('\n== TOOLS ==');
for (const t of tools) console.log(` ${t.function?.name || t.type} [${t.type}] url=${t.server?.url || ''} timeout=${t.server?.timeoutSeconds || ''} dest=${JSON.stringify(t.destinations || null)?.slice(0, 300)} msgs=${JSON.stringify((t.messages || []).map(m => m.type + ':' + (m.content || '')))?.slice(0, 300)}\n   desc: ${(t.function?.description || '').slice(0, 300)}`);
