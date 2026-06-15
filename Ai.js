// ╔════════════════════════════════════════════════════════════════════════╗
// ║                                                                        ║
// ║   Ai.js — Pont entre l'agent VAPI (téléphone/SMS) et Shopify           ║
// ║   Barracuda Piscines & Spas — Gatineau, QC                             ║
// ║                                                                        ║
// ║   À QUOI SERT CE FICHIER (en deux phrases) :                           ║
// ║   1. C'est le « cerveau intermédiaire » entre l'IA qui parle aux       ║
// ║      clients (par téléphone ou SMS) et la boutique Shopify.            ║
// ║   2. Quand l'IA a besoin de chercher un produit ou une commande,       ║
// ║      elle appelle ce serveur, qui interroge Shopify et lui répond.     ║
// ║                                                                        ║
// ║   CE QUE FAIT CE FICHIER, DANS L'ORDRE :                               ║
// ║   ① Démarre un serveur web (Express) sur Railway                       ║
// ║   ② Expose des endpoints (= adresses web) que VAPI et Twilio appellent ║
// ║      • POST /search_shopify_products  — l'IA cherche un produit        ║
// ║      • POST /search_shopify_orders    — l'IA cherche une commande      ║
// ║      • POST /sms/incoming             — Twilio envoie un SMS reçu      ║
// ║      • POST /weekly-analysis          — déclenche le coach hebdo       ║
// ║      • GET  /events/stats             — voir les stats live            ║
// ║      • GET  /diagnose-shopify         — test rapide de Shopify         ║
// ║      • GET  /diagnose-sms             — test rapide de VAPI Chat       ║
// ║      • GET  /                         — page d'accueil santé           ║
// ║   ③ Enregistre dans la mémoire chaque action importante (= « events ») ║
// ║      pour produire les stats du rapport hebdo                          ║
// ║   ④ Tous les dimanches 23h, un « coach IA » lit les appels de la       ║
// ║      semaine et envoie un rapport courriel avec ce qui va bien/mal     ║
// ║                                                                        ║
// ║   VOCABULAIRE RAPIDE :                                                 ║
// ║   • Endpoint = une « adresse web » que d'autres systèmes peuvent       ║
// ║     appeler (ex: POST /search_shopify_products)                        ║
// ║   • Tool VAPI = fonction que l'IA vocale peut appeler quand elle       ║
// ║     en a besoin (recherche produit, recherche commande, etc.)          ║
// ║   • GraphQL = langage de requête pour parler à Shopify                 ║
// ║   • Synonymes = dictionnaire de mots équivalents (« chlore » =         ║
// ║     « chlorine », « filtreur » = « filtre », etc.) pour que            ║
// ║     l'IA trouve les produits même quand le client utilise un autre mot ║
// ║                                                                        ║
// ╚════════════════════════════════════════════════════════════════════════╝


// ╭───────────────────────────────────────────────────────────────────────╮
// │  1. IMPORTS — On charge les outils qu'on va utiliser                  │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Chaque ligne ci-dessous = « va chercher tel outil dans node_modules
// pour qu'on puisse l'utiliser dans ce fichier ».

import express from "express";       // Le serveur web (gère les requêtes HTTP entrantes)
import cors from "cors";             // Permet à des sites externes d'appeler notre serveur
import fetch from "node-fetch";      // Pour faire des appels web SORTANTS (vers Shopify, VAPI, etc.)
import dotenv from "dotenv";         // Charge les variables secrètes (.env / Railway)
import crypto from "crypto";         // Pour hasher les numéros de téléphone (anonymisation)

// Active dotenv : lit le fichier .env (en local) ou les variables Railway (en prod)
dotenv.config();

// Crée l'application serveur
const app = express();
app.use(cors());                                  // Autorise les appels d'autres domaines
// limit "5mb" : VAPI envoie tout le transcript de l'appel dans le payload du tool.
// En cours d'appel l'historique grossit et dépasse la limite express par défaut
// (100 kb) → rejet HTTP 413 → le tool échoue et l'IA reste muette ("un instant"
// puis silence). 5 mb donne une marge large.
app.use(express.json({ limit: "5mb" }));          // Comprend les requêtes en JSON
app.use(express.urlencoded({ extended: true, limit: "5mb" })); // formulaire (Twilio)


// ╭───────────────────────────────────────────────────────────────────────╮
// │  2. ENV — Variables d'environnement (secrets et configuration)         │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Ces valeurs SONT CONFIGURÉES dans Railway (onglet Variables).
// Si tu veux changer une de ces valeurs, va dans Railway, pas ici.
// Ce fichier les LIT seulement.

// Le port sur lequel le serveur écoute (Railway le fournit automatiquement)
const PORT = process.env.PORT || 8080;

// Connexion à la boutique Shopify
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;            // ex: barracuda-piscines.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;              // shpat_xxxx — clé d'accès Admin API
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04"; // version de l'API Shopify

// Connexion à VAPI (la plateforme qui héberge notre IA vocale)
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;        // clé API VAPI
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;      // ID de l'assistant utilisé pour le SMS (= l'assistant FR)

// Coach IA hebdo (analyse automatique des appels de la semaine)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;      // clé Claude (Anthropic)
const RESEND_API_KEY = process.env.RESEND_API_KEY;            // clé Resend (envoi de courriels)
const REPORT_EMAIL_TO = process.env.REPORT_EMAIL_TO;          // adresse qui reçoit le rapport hebdo
const REPORT_EMAIL_FROM = process.env.REPORT_EMAIL_FROM || "Barracuda Coach <onboarding@resend.dev>"; // expéditeur du rapport
const ANALYSIS_SECRET = process.env.ANALYSIS_SECRET || "change-me"; // mot de passe pour déclencher /weekly-analysis manuellement
// .trim() : une variable Railway avec un espace parasite (« America/Toronto ») faisait
// planter toLocaleString({ timeZone }) — ça cassait l'envoi des courriels voicemail ET coach.
const ANALYSIS_TIMEZONE = (process.env.ANALYSIS_TIMEZONE || "America/Toronto").trim(); // fuseau horaire pour le cron du dimanche

// Boîte vocale (voicemail Twilio → courriel sur le compte Resend info@)
// IMPORTANT : compte Resend SÉPARÉ de celui du coach hebdo. Le free tier Resend
// ne permet d'envoyer QUE vers l'email d'inscription du compte tant qu'aucun
// domaine n'est vérifié. Le compte info@ peut donc écrire à info@, l'ancien
// compte (RESEND_API_KEY) continue d'écrire à nathan_leonard05@outlook.com pour le coach.
const RESEND_API_KEY_VOICEMAIL = process.env.RESEND_API_KEY_VOICEMAIL; // clé du compte Resend info@
const VOICEMAIL_EMAIL_TO = process.env.VOICEMAIL_EMAIL_TO || "info@piscinesbarracuda.com";
const VOICEMAIL_EMAIL_FROM = process.env.VOICEMAIL_EMAIL_FROM || "Barracuda Boite Vocale <onboarding@resend.dev>";
// Creds Twilio OPTIONNELS : seulement pour télécharger l'audio et le joindre au courriel.
// Absents → le courriel contient quand même le lien d'écoute (dégradation propre).
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
// SMS SORTANT (chantier 5) : numéro Twilio expéditeur (E.164, ex: +18196174343)
// et texte du SMS de bienvenue envoyé sur « oui » à l'accueil (modifiable sans code).
const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM;
const WELCOME_SMS_TEXT = process.env.WELCOME_SMS_TEXT ||
  "Ici Piscines Barracuda. Répondez à ce message avec votre question — produit, commande ou horaire — et notre assistant vous aide immédiatement. Merci de votre appel!";
// URL publique de ce serveur (pour les callbacks Twilio). Défaut = l'URL prod Railway connue.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://barracuda-ai-agent-production-806d.up.railway.app").replace(/\/+$/, "");
// Message d'accueil joué quand personne ne répond (modifiable via env sans toucher au code).
const VOICEMAIL_GREETING = process.env.VOICEMAIL_GREETING ||
  "Bonjour, vous avez bien rejoint Barracuda Piscines et Spas. Nous ne sommes pas en mesure de prendre votre appel pour le moment. Laissez-nous votre nom, votre numero de telephone et votre message apres le bip sonore, et nous vous rappellerons des que possible. Merci!";

// VAPI_ASSISTANTS_MAP : table de correspondance UUID → nom lisible
// Pourquoi ? Quand un appel se termine, VAPI nous dit « assistantId = abc123... »
// mais ça ne veut rien dire. On veut savoir si c'était Accueil, FR ou EN.
// Format attendu dans Railway : {"uuid-accueil":"Accueil","uuid-fr":"FR","uuid-en":"EN"}
let VAPI_ASSISTANTS_MAP = {};
try {
  VAPI_ASSISTANTS_MAP = process.env.VAPI_ASSISTANTS_MAP
    ? JSON.parse(process.env.VAPI_ASSISTANTS_MAP)
    : {};
} catch (err) {
  // Si le JSON dans Railway est mal écrit, on continue sans crasher,
  // mais les stats par assistant seront vides.
  console.warn("[BOOT] VAPI_ASSISTANTS_MAP invalide (JSON malformé) — split par assistant désactivé:", err.message);
  VAPI_ASSISTANTS_MAP = {};
}

// Avertissements au démarrage si une variable cruciale manque (pour debug rapide)
if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
  console.warn("[BOOT] WARNING: SHOPIFY_DOMAIN or SHOPIFY_TOKEN missing — Shopify calls will fail.");
}
if (!VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
  console.warn("[BOOT] WARNING: VAPI_PRIVATE_KEY or VAPI_ASSISTANT_ID missing — SMS will fail.");
}
if (!ANTHROPIC_API_KEY || !RESEND_API_KEY || !REPORT_EMAIL_TO) {
  console.warn("[BOOT] WARNING: ANTHROPIC_API_KEY / RESEND_API_KEY / REPORT_EMAIL_TO missing — weekly analysis will fail.");
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  3. EVENT LOGGING — Le « carnet d'événements » du serveur             │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// CONCEPT : à chaque action importante (recherche produit, SMS reçu,
// erreur, etc.), on ajoute une ligne dans une liste en mémoire.
// Chaque dimanche, le coach lit cette liste, fait des statistiques,
// puis vide la liste.
//
// LIMITE : la liste est EN MÉMOIRE. Si Railway redémarre, la liste est
// vidée. Pour le volume actuel (~20 appels/jour), c'est acceptable.
// Si on doit garder les événements à travers les redémarrages, on
// migrera vers une base de données.

const EVENTS = [];               // La liste qui contient tous les événements
const EVENTS_MAX = 10_000;       // Sécurité : on garde au max 10 000 événements

// Ajoute un événement dans la liste
// type = nom de l'événement (ex: "sms_received")
// meta = données associées (ex: { phone_hash: "abc", body_len: 42 })
function logEvent(type, meta = {}) {
  EVENTS.push({ ts: new Date().toISOString(), type, ...meta });
  // Si on dépasse la limite, on enlève les plus vieux (FIFO = first-in-first-out)
  if (EVENTS.length > EVENTS_MAX) {
    EVENTS.splice(0, EVENTS.length - EVENTS_MAX);
  }
}

// Renvoie une COPIE de la liste, puis vide l'originale.
// Utilisé par le coach hebdo après envoi réussi du courriel.
function drainEvents() {
  const snapshot = EVENTS.slice();   // copie
  EVENTS.length = 0;                 // vide la liste originale
  return snapshot;
}

// Renvoie une COPIE de la liste SANS la vider.
// Utilisé pour /events/stats (debug live) et pour calculer les stats
// du coach hebdo AVANT d'envoyer le courriel (au cas où ça plante,
// on ne perd pas les events).
function peekEvents() {
  return EVENTS.slice();
}

// Transforme un numéro de téléphone en code court (12 caractères hex)
// Pourquoi ? Pour pouvoir grouper les SMS du même client SANS stocker
// son numéro de téléphone en clair (= protection PII).
function hashPhone(phone) {
  return crypto.createHash("sha256").update(String(phone || "")).digest("hex").slice(0, 12);
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  4. HELPER — Communication avec Shopify (GraphQL)                     │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Pour parler à Shopify, on utilise GraphQL (un langage de requête).
// Cette fonction est UTILISÉE par toutes les recherches Shopify du fichier.
// Elle envoie la requête, vérifie qu'il n'y a pas d'erreur, et renvoie
// les données. Si erreur, elle « lance une exception » que les fonctions
// appelantes attrapent avec try/catch.

async function fetchShopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  // Timeout 8 s : sans ça, si Shopify ne répond pas, le fetch reste suspendu
  // indéfiniment (on a déjà vu un appel hang ~5 min → VAPI ferme → silence).
  // Au-delà de 8 s on abandonne proprement : l'exception remonte, la cascade
  // passe au niveau suivant ou renvoie une erreur que l'IA peut verbaliser.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_TOKEN,   // notre clé d'accès Shopify
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Shopify GraphQL timeout après 8s");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // Si Shopify renvoie une erreur HTTP (ex: 401 = pas autorisé, 500 = bug Shopify)
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${text}`);
  }

  const json = await response.json();

  // Si Shopify renvoie 200 OK mais avec des erreurs dans le JSON (ex: champ inexistant)
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  5. HELPER — Extraction du payload VAPI                               │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Quand l'IA vocale VAPI appelle un de nos tools (ex: search_shopify_products),
// elle envoie une grosse enveloppe JSON. Les VRAIES données dont on a besoin
// (les arguments du tool, et un identifiant) sont enfouies à l'intérieur.
// Ce helper va les chercher.

function getVapiToolCall(req) {
  const toolCall = req.body?.message?.toolCalls?.[0];
  let args = toolCall?.function?.arguments ?? {};
  // Parfois VAPI envoie les arguments comme une chaîne JSON au lieu d'un objet — on parse
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return { toolCall, toolCallId: toolCall?.id ?? null, args: args || {} };
}

// Construit la réponse au format exact que VAPI attend pour un tool call
function vapiResult(toolCallId, result) {
  return { results: [{ toolCallId, result }] };
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  6. NORMALISATION & TOKENISATION du texte de recherche                │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Quand un client dit « j'ai besoin d'un Filtre HAYWARD », on veut chercher
// en réalité « filtre hayward » (en minuscules, sans accents, sans ponctuation).
// Ces fonctions font ce ménage avant d'envoyer la requête à Shopify.

// Convertit un texte en sa forme « propre » : minuscules, sans accents, sans ponctuation
function normalize(s = "") {
  return String(s)
    .toLowerCase()                       // tout en minuscules
    .normalize("NFD")                    // décompose les accents (é → e + accent)
    .replace(/[̀-ͯ]/g, "")              // retire les marques d'accent
    .replace(/[^\w\s-]/g, " ")           // retire ponctuation (sauf tiret)
    .replace(/\s+/g, " ")                // collapse les espaces multiples
    .trim();
}

// Mots vides FR/EN — ces mots ne servent à rien dans une recherche et sont retirés
// (ex: « le », « la », « pour », « the », « of »...)
const STOPWORDS = new Set([
  "le","la","les","l","de","des","du","d","un","une","et","ou","a","au","aux",
  "pour","avec","sans","sur","sous","dans","par","ce","cette","ces","mon","ma",
  "mes","ton","ta","tes","son","sa","ses","est","sont","je","tu","il","elle",
  "on","nous","vous","ils","elles","qui","que","quoi","dont","ne","pas","plus",
  "the","of","and","or","for","with","without","on","in","by","this","that",
  "is","are","be","to","at","from","as","an"
]);

// Découpe une phrase en mots utiles
// Ex : « J'ai besoin d'un filtre Hayward » → ["besoin", "filtre", "hayward"]
function tokenize(s) {
  return normalize(s)
    .split(" ")
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));  // garde les mots de 2+ caractères qui ne sont pas des stopwords
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  7. DICTIONNAIRE DE SYNONYMES — FR ↔ EN ↔ jargon piscine/spa          │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Le client peut dire « filtreur », « filter », « filtration » — on veut
// que ça matche tous les produits qui contiennent « filtre » dans le catalogue.
// Ce dictionnaire regroupe les mots équivalents.
//
// COMMENT AJOUTER UN SYNONYME ?
//   1. Trouve la catégorie (Chimie, Équipement, Marques, etc.)
//   2. Ajoute une nouvelle ligne avec :
//        "mot_principal": ["synonyme1", "synonyme2", ...],
//   3. Sauvegarde, push sur Git, Railway redéploie automatiquement.
//
// Le mot principal n'a pas besoin d'être en français — c'est juste la clé.

const SYNONYMS = {
  // --- Chimie de l'eau ---
  "chlore":      ["chlorine", "chl", "trichlore", "dichlore", "hypochlorite"],
  "brome":       ["bromine"],
  "ph":          ["ph minus", "ph plus", "ph moins", "ph up", "ph down"],
  "acide chlorhydrique": ["acide muriatique", "muriatique", "muriatic acid", "muriatic"],
  "alcalinite":  ["alkalinity", "alc", "ta"],
  "durete":      ["calcium", "hardness", "ch", "durete calcique"],
  "stabilisant": ["stabilizer", "acide cyanurique", "cya", "cyanuric"],
  "algicide":    ["algaecide", "algecide", "anti algues", "anti-algues"],
  "floculant":   ["flocculant", "clarifiant", "clarifier"],
  "sel":         ["salt", "saline", "electrolyse", "electrolyseur", "salt cell", "cell", "cellule", "intellichlor", "aquarite"],
  "oxygene":     ["oxygen", "peroxyde", "shock"],
  "choc":        ["shock", "superchloration", "super chlore"],
  "smartchoc":   ["smart shock", "smart choc", "smartshock", "bioguard smart shock"],

  // --- Équipement ---
  "pompe":       ["pump", "circulateur", "moteur"],
  "filtre":      ["filter", "filtration", "filtreur"],
  "cartouche":   ["cartridge", "element filtrant"],
  "sable":       ["sand", "sable filtrant"],
  "verre":       ["glass media", "verre filtrant"],
  "chauffage":   ["heater", "rechauffeur", "thermopompe", "heat pump", "chauffe eau", "chauffe-eau", "pompe a chaleur"],
  "echangeur":   ["exchanger", "heat exchanger"],
  "minuterie":   ["timer", "horloge", "controle"],
  "ecumoir":     ["skimmer", "ecumeur", "ecumoire", "ecumeware"],
  "buse":        ["jet", "return", "refoulement", "eyeball"],
  "valve":       ["vanne", "valve multivoie", "multivoies", "multiport", "soupape", "variflo", "vari flo", "veriflow", "spring valve"],
  "ressort":     ["spring", "spring valve", "ressort de soupape"],
  "tuyau":       ["hose", "boyau", "pipe", "conduite"],
  "raccord":     ["fitting", "union", "coude", "te", "elbow"],
  "joint":       ["o-ring", "oring", "o ring", "joint torique", "gasket", "seal", "joint detancheite"],
  "drain":       ["drain de fond", "main drain", "bonde", "bouchon de vidange", "drain plug", "plug"],

  // --- Liner / structure / type de piscine ---
  "toile":       ["liner", "toile vinyle", "vinyl liner", "membrane"],
  "vinyle":      ["vinyl", "pvc"],
  "fibre":       ["fiberglass", "fibre de verre", "fiberglass pool"],
  "beton":       ["concrete", "gunite"],
  "creusee":     ["inground", "in ground", "enterree", "enterre"],
  "horsterre":   ["hors terre", "above ground", "aboveground", "ht"],
  "semi":        ["semi creusee", "semi enterree", "semi inground"],
  "poteau":      ["poteaux", "upright", "post", "montant"],
  "plaque":      ["plaques", "plate", "wall fitting", "plaque de base", "rail"],

  // --- Marques fréquentes (à enrichir au besoin) ---
  "helios":      ["hellios"],
  "soprema":     [],
  "hayward":     [],
  "pentair":     [],
  "jandy":       [],
  "zodiac":      [],
  "raypak":      [],
  "intex":       [],
  "bestway":     [],
  "bayrol":      [],
  "bioguard":    [],
  "hydropool":   [],
  "sundance":    [],
  "bullfrog":    [],
  "starite":     ["sta rite", "sta-rite", "staright"],
  "aqualeader":  ["aqua leader", "aquatour", "aqua tour", "aquatours"],
  "variflo":     ["vari flo", "vari-flo", "veriflow", "veri flow"],

  // --- Tests d'eau ---
  "bandelette":  ["bandelettes", "strip", "strips", "test strip", "bandes test"],
  "analyse":     ["analysis", "test eau", "water analysis", "water test"],
  "trousse":     ["kit", "test kit", "trousse danalyse"],
  "reactif":     ["reagent", "reactifs", "reagents"],

  // --- Spa ---
  "spa":         ["hot tub", "jacuzzi", "tourbillon", "bain a remous", "tub", "hydropool", "sundance", "bullfrog", "hydromassage"],
  "filtre spa":  ["spa filter", "filtre jacuzzi"],
  "clavier spa": ["topside", "topside control", "control pad", "keypad", "clavier de controle"],
  // « clavier » seul (token unique) : la clé multi-mots « clavier spa » ne matche pas
  // le mot « clavier » employé seul au téléphone (recherche clavier de contrôle spa Balboa).
  "clavier":     ["topside", "topside control", "keypad", "clavier de controle", "clavier spa", "pad"],
  "element chauffant": ["heating element", "heater element", "element chauffant spa"],

  // --- Piscine générique ---
  "piscine":     ["pool", "swimming pool", "bassin"],

  // --- Couverture / hivernage ---
  "couverture":  ["cover", "bache", "toile dhiver", "winter cover", "couvert", "couvercle de spa", "spa cover"],
  "solaire":     ["solar cover", "couverture solaire", "bache solaire", "bulle"],
  "hivernage":   ["winter", "winterizing", "wintering", "fermeture"],
  "ouverture":   ["opening", "demarrage"],

  // --- Nettoyage ---
  "robot":       ["robotic cleaner", "aspirateur robot", "cleaner", "polaris", "dolphin", "nettoyeur", "robot nettoyeur", "robot de piscine", "nettoyeur de piscine", "pool cleaner"],
  "balai":       ["brush", "broom", "brosse"],
  "epuisette":   ["skim net", "leaf net", "puise"],
  "aspirateur":  ["vacuum", "aspirateur manuel"],
  "tuyau aspirateur": ["vacuum hose"],

  // --- Éclairage / accessoires ---
  "lumiere":     ["light", "led", "eclairage"],
  "echelle":     ["ladder", "marche"],
  "plongeoir":   ["diving board", "tremplin"],
};

// Construction d'un index inversé : pour CHAQUE mot du dictionnaire,
// on garde la liste de TOUS ses équivalents (incluant lui-même).
// Comme ça, qu'on cherche « filtre », « filter » ou « filtreur »,
// on tombe sur la même liste : ["filtre", "filter", "filtration", "filtreur"].
//
// C'est calculé UNE FOIS au démarrage du serveur (la fonction se lance
// immédiatement grâce aux parenthèses à la fin).
const SYNONYM_LOOKUP = (() => {
  const map = new Map();
  for (const [canonical, variants] of Object.entries(SYNONYMS)) {
    const all = [canonical, ...variants].map(normalize).filter(Boolean);
    for (const term of all) {
      const existing = map.get(term) || new Set();
      for (const t of all) existing.add(t);
      map.set(term, existing);
    }
  }
  return map;
})();

// Pour un mot donné, renvoie la liste complète de ses synonymes
// (ou le mot lui-même s'il n'est pas dans le dictionnaire)
function expandSynonyms(token) {
  const n = normalize(token);
  const set = SYNONYM_LOOKUP.get(n);
  return set ? [...set] : [n];
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  8. CONSTRUCTEUR DE REQUÊTE SHOPIFY                                   │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Shopify a son propre langage de recherche (Search Syntax).
// Cette fonction transforme nos tokens + filtres en une requête
// que Shopify comprend, ADAPTÉE au niveau de cascade qu'on essaie.
//
// ⚠️ PIÈGE IMPORTANT : Shopify supporte les wildcards en SUFFIXE seulement.
// « filtre* » → trouve « filtre », « filtres », « filtreur » ✅
// « *filtre* » → renvoie 0 résultats SILENCIEUSEMENT ❌
// C'est pour ça que dans le code, on met TOUJOURS l'étoile à la fin.

// Échappe les guillemets pour les insérer dans une valeur de recherche Shopify
function esc(v) {
  return String(v).replace(/"/g, '\\"');
}

// Construit la requête Shopify en fonction du niveau de cascade qu'on est en train d'essayer.
// Chaque niveau est PLUS LARGE que le précédent (= matche plus de produits).
function buildShopifyQuery({ tokens, vendor, productType, tags, inStockOnly, level }) {
  const parts = [];

  if (tokens && tokens.length > 0) {
    if (level === "STRICT") {
      // Niveau 1 : chaque mot doit apparaître EXACTEMENT (pas de wildcard)
      const block = tokens.map(tok => `title:${tok}`).join(" AND ");
      parts.push(block);
    } else if (level === "TOKENS") {
      // Niveau 2 : préfixe sur chaque mot, recherche dans titre/tags/type
      const block = tokens
        .map(tok => `(title:${tok}* OR tag:${tok}* OR product_type:${tok}*)`)
        .join(" AND ");
      parts.push(block);
    } else if (level === "SYNONYMES") {
      // Niveau 3 : on ajoute les synonymes (« filtre » = « filter » = « filtreur »...)
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        const ors = syns
          .map(s => `title:${s}* OR tag:${s}* OR product_type:${s}* OR vendor:${s}*`)
          .join(" OR ");
        return `(${ors})`;
      }).join(" AND ");
      parts.push(block);
    } else if (level === "FILTERS_OFF") {
      // Niveau 4 : on retire les filtres (marque, type, stock) pour élargir
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        const ors = syns.map(s => `title:${s}* OR tag:${s}*`).join(" OR ");
        return `(${ors})`;
      }).join(" AND ");
      parts.push(block);
    } else if (level === "KEYWORD") {
      // Niveau 5 : on garde SEULEMENT le mot le plus long + ses synonymes
      const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
      const syns = expandSynonyms(longest);
      const ors = syns.map(s => `title:${s}* OR tag:${s}*`).join(" OR ");
      parts.push(`(${ors})`);
    } else if (level === "TAGS_ONLY") {
      // Niveau 6 : recherche SEULEMENT dans les tags (catégories)
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        return `(${syns.map(s => `tag:${s}*`).join(" OR ")})`;
      }).join(" OR ");
      parts.push(block);
    } else if (level === "FULLTEXT") {
      // Niveau 7 (dernier recours) : recherche libre, Shopify fait comme il veut
      parts.push(tokens.join(" "));
    }
  }

  // Filtres structurels (marque, type, tags) + filtre stock :
  // ces filtres ne sont gardés QU'AUX NIVEAUX STRICTS.
  // À partir de FILTERS_OFF, on les retire pour maximiser les chances de trouver quelque chose.
  const keepAllFilters = level === "STRICT" || level === "TOKENS" || level === "SYNONYMES" || level === "FILTERS_ONLY";

  if (keepAllFilters) {
    if (vendor) parts.push(`vendor:"${esc(vendor)}"`);
    if (productType) parts.push(`product_type:"${esc(productType)}"`);
    if (tags && tags.length) {
      const tagPart = tags.map(t => `tag:"${esc(t)}"`).join(" AND ");
      parts.push(`(${tagPart})`);
    }
    // NOTE: in_stock_only n'est PLUS filtré ici via inventory_total:>0 — ça excluait
    // l'inventaire NON suivi mais vendable (ex. filtreur Hayward: stock 0, available true).
    // Le filtre de disponibilité se fait APRÈS le fetch, sur availableForSale
    // (voir endpoint /search_shopify_products).
  }

  // On exclut TOUJOURS les produits en brouillon ou archivés
  parts.push(`status:active`);

  // Joint toutes les parties avec « AND » pour faire la requête finale
  return parts.join(" AND ");
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  9. REQUÊTE GRAPHQL PRODUITS — Le « formulaire » qu'on envoie         │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Cette grosse chaîne en GraphQL dit à Shopify :
// « Donne-moi les N premiers produits qui matchent ma recherche $q,
//   avec leur titre, prix, variantes, inventaire, image, etc. »

const PRODUCTS_GQL = `
  query SearchProducts($q: String!, $first: Int!) {
    products(first: $first, query: $q, sortKey: RELEVANCE) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          tags
          totalInventory
          onlineStoreUrl
          featuredImage { url altText }
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          variants(first: 10) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryQuantity
                availableForSale
                inventoryItem {
                  inventoryLevels(first: 3) {
                    edges { node { quantities(names: ["incoming"]) { name quantity } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;


// ╭───────────────────────────────────────────────────────────────────────╮
// │  10. RECHERCHE EN CASCADE — Élargir la recherche si rien trouvé       │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// PRINCIPE : on essaie d'abord la recherche la plus PRÉCISE.
// Si on trouve 0 produit, on retente avec une recherche un peu plus LARGE.
// On répète jusqu'à trouver quelque chose, ou jusqu'à épuiser tous les niveaux.
//
// L'ordre des niveaux (du plus précis au plus large) :
//   1. STRICT       — match exact des mots
//   2. TOKENS       — chaque mot avec wildcard de suffixe
//   3. SYNONYMES    — on ajoute les synonymes FR/EN
//   4. FILTERS_OFF  — on retire les filtres (marque, type, stock)
//   5. KEYWORD      — seulement le mot le plus long
//   6. TAGS_ONLY    — recherche dans les catégories seulement
//   7. FULLTEXT     — recherche libre, dernier recours

const CASCADE_LEVELS = ["STRICT", "TOKENS", "SYNONYMES", "FILTERS_OFF", "KEYWORD", "TAGS_ONLY", "FULLTEXT"];

// Filtre les produits par prix (côté serveur, après que Shopify ait répondu).
// Pourquoi pas dans la requête Shopify ? Parce que Shopify ne supporte pas
// le filtre prix dans la search syntax — il faut le faire après.
function applyPriceFilter(products, minPrice, maxPrice) {
  if (minPrice == null && maxPrice == null) return products;
  return products.filter(p => {
    const min = parseFloat(p.priceRangeV2?.minVariantPrice?.amount ?? "0");
    const max = parseFloat(p.priceRangeV2?.maxVariantPrice?.amount ?? "0");
    if (minPrice != null && max < minPrice) return false;       // tout l'éventail sous le min
    if (maxPrice != null && min > maxPrice) return false;       // tout l'éventail au-dessus du max
    return true;
  });
}

// Lance une recherche Shopify et renvoie la liste des produits
async function runShopifySearch(qStr, fetchCount) {
  const data = await fetchShopifyGraphQL(PRODUCTS_GQL, { q: qStr, first: fetchCount });
  return (data.products?.edges || []).map(e => e.node);
}

// La FONCTION PRINCIPALE de la cascade.
// On essaie chaque niveau l'un après l'autre jusqu'à trouver des résultats.
async function cascadeSearch(args) {
  const {
    query, vendor, productType, tags,
    minPrice, maxPrice, inStockOnly,
    limit, widenIfEmpty,
  } = args;

  const tokens = tokenize(query);
  // On demande à Shopify plus de produits que la limite finale, pour avoir
  // une marge si le filtre prix retire des résultats après coup.
  const fetchCount = Math.min(Math.max(limit * 2, 10), 100);
  const debugTrace = []; // log de toutes les tentatives, utile en cas de 0 résultat

  // CAS 1 : aucun mot fourni (le client a juste filtré par marque/type)
  if (tokens.length === 0) {
    const q = buildShopifyQuery({ tokens: [], vendor, productType, tags, inStockOnly, level: "FILTERS_ONLY" });
    try {
      const raw = await runShopifySearch(q, fetchCount);
      const products = applyPriceFilter(raw, minPrice, maxPrice);
      debugTrace.push({ level: "FILTERS_ONLY", query: q, fetched: raw.length, after_price_filter: products.length });
      return {
        products: products.slice(0, limit),
        level: "FILTERS_ONLY",
        finalQuery: q,
        widened: false,
        debugTrace,
      };
    } catch (err) {
      debugTrace.push({ level: "FILTERS_ONLY", query: q, error: err.message });
      return { products: [], level: "NONE", finalQuery: null, widened: true, debugTrace };
    }
  }

  // CAS 2 : il y a du texte → on lance la cascade.
  // Si widenIfEmpty = false, on s'arrête après les 3 premiers niveaux (STRICT/TOKENS/SYNONYMES).
  const levels = widenIfEmpty ? CASCADE_LEVELS : CASCADE_LEVELS.slice(0, 3);

  for (const level of levels) {
    const q = buildShopifyQuery({ tokens, vendor, productType, tags, inStockOnly, level });
    let products;
    try {
      products = await runShopifySearch(q, fetchCount);
    } catch (err) {
      console.error(`[cascade] level=${level} FAILED query="${q}" err=${err.message}`);
      debugTrace.push({ level, query: q, error: err.message });
      continue; // ce niveau a planté, on tente le suivant
    }

    const before = products.length;
    products = applyPriceFilter(products, minPrice, maxPrice);
    debugTrace.push({ level, query: q, fetched: before, after_price_filter: products.length });
    console.log(`[cascade] level=${level} query="${q}" fetched=${before} after_price_filter=${products.length}`);

    // Bingo, on a trouvé au moins un produit → on s'arrête là
    if (products.length > 0) {
      return {
        products: products.slice(0, limit),
        level,
        finalQuery: q,
        widened: level !== "STRICT",  // « widened » = vrai si on a élargi au-delà du niveau strict
        debugTrace,
      };
    }
  }

  // Tous les niveaux ont retourné 0 → vraiment rien à proposer
  return { products: [], level: "NONE", finalQuery: null, widened: true, debugTrace };
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  11. FORMATAGE DES RÉSULTATS POUR L'IA VAPI                           │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// L'IA reçoit la liste des produits trouvés. On la simplifie pour ne
// garder QUE ce qui lui sert (titre, prix, stock, URL, image, variantes).

// ⭐ GARDE-FOU PRIX (corrige le bug du « 99999 dollars » lu à voix haute).
// Shopify renvoie parfois un prix bidon (99999 = produit « sur demande »,
// 0 = pas de prix, ou valeur manquante). Tout prix nul, négatif, non
// numérique, ou au-dessus de ce seuil est jugé invalide : on renvoie null
// + un drapeau price_unavailable que le prompt Vapi sait gérer (Barry ne
// lit alors AUCUN chiffre et propose de confirmer le prix autrement).
const PRICE_SANITY_MAX = 10000;

function sanePrice(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n <= 0 || n > PRICE_SANITY_MAX) return null;
  return n;
}

// Prix en LETTRES françaises — ⚠️ obligatoire : ElevenLabs lit les CHIFFRES en ANGLAIS
// même sur une voix française (« 499 » → « four hundred ninety-nine »), comme pour les
// dates (« deux mille vingt-six » et pas « 2026 »). On épelle donc le prix en français.
// On délègue l'épellation au serveur (déterministe et correcte) car Haiku se trompe
// parfois (« quatre cent vingt dix neuf » au lieu de « quatre cent quatre-vingt-dix-neuf »).
const FR_U = ["zéro","un","deux","trois","quatre","cinq","six","sept","huit","neuf","dix","onze","douze","treize","quatorze","quinze","seize","dix-sept","dix-huit","dix-neuf"];
const FR_T = ["","","vingt","trente","quarante","cinquante","soixante"];
function frBelow100(n) {
  if (n < 20) return FR_U[n];
  if (n < 70) { const t = Math.floor(n / 10), u = n % 10; const w = FR_T[t]; if (u === 0) return w; if (u === 1) return w + " et un"; return w + "-" + FR_U[u]; }
  if (n < 80) { if (n === 71) return "soixante et onze"; return "soixante-" + FR_U[n - 60]; }
  if (n < 90) { const u = n - 80; return u === 0 ? "quatre-vingts" : "quatre-vingt-" + FR_U[u]; }
  return "quatre-vingt-" + FR_U[n - 80];
}
function frBelow1000(n) {
  if (n < 100) return frBelow100(n);
  const h = Math.floor(n / 100), r = n % 100;
  const cent = h === 1 ? "cent" : FR_U[h] + " cent" + (r === 0 ? "s" : "");
  return r === 0 ? cent : cent + " " + frBelow100(r);
}
function frNumber(n) {
  n = Math.floor(n);
  if (n < 1000) return frBelow1000(n);
  const th = Math.floor(n / 1000), r = n % 1000;
  const mil = th === 1 ? "mille" : frBelow1000(th) + " mille";
  return r === 0 ? mil : mil + " " + frBelow1000(r);
}
function priceToSpokenFr(amount) {
  if (amount == null || !isFinite(amount)) return null;
  const d = Math.floor(amount), c = Math.round((amount - d) * 100);
  const dp = frNumber(d) + " dollar" + (d > 1 ? "s" : "");
  return c === 0 ? dp : dp + " et " + frBelow100(c);
}

function formatProduct(p) {
  const priceMin = sanePrice(p.priceRangeV2?.minVariantPrice?.amount);
  const priceMax = sanePrice(p.priceRangeV2?.maxVariantPrice?.amount);

  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    vendor: p.vendor,
    product_type: p.productType,
    tags: p.tags,
    total_inventory: p.totalInventory,
    url: p.onlineStoreUrl,
    image: p.featuredImage?.url || null,
    price_min: priceMin,
    price_max: priceMax,
    price_spoken: priceToSpokenFr(priceMin),   // prix en lettres FR, à dire tel quel (voix)
    // true = prix invalide en base (99999, 0, manquant) → NE PAS l'annoncer.
    price_unavailable: priceMin === null,
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode || "CAD",
    variants: (p.variants?.edges || []).map(v => {
      const vp = sanePrice(v.node.price);
      // Stock ENTRANT (commandé mais pas encore reçu) : somme du "incoming" sur les emplacements.
      const incoming = (v.node.inventoryItem?.inventoryLevels?.edges || [])
        .reduce((sum, lvl) => {
          const q = (lvl.node.quantities || []).find(x => x.name === "incoming");
          return sum + (q && typeof q.quantity === "number" ? q.quantity : 0);
        }, 0);
      return {
        id: v.node.id,
        title: v.node.title,
        sku: v.node.sku,
        price: vp,                       // null si bidon, au lieu de 99999
        price_unavailable: vp === null,
        price_spoken: priceToSpokenFr(vp),  // prix en lettres FR, à dire tel quel (voix)
        stock: v.node.inventoryQuantity,
        available: v.node.availableForSale,
        incoming,                        // quantité en commande pas encore reçue
      };
    }),
  };
}

// Marques (hors Nirvana) : si le client en nomme une dans sa demande, on NE force
// PAS Nirvana en tête (il a une marque précise en tête). Inclut variantes courantes.
const OTHER_BRANDS = [
  "helios", "soprema", "hayward", "pentair", "jandy", "zodiac", "raypak", "intex",
  "bestway", "bayrol", "bioguard", "hydropool", "sundance", "bullfrog",
  "starite", "sta rite", "aqualeader", "aqua leader", "variflo", "vari flo",
  "jacuzzi", "carvin", "waterway", "hydroquip", "balboa", "gecko",
];

// Préférence marque pour les FILTRES (décision business) : remonter les filtres
// Nirvana DISPONIBLES en tête des résultats. Fait une recherche ciblée Nirvana
// (car les filtres Nirvana ne remontent pas dans une recherche "filtre" générique),
// garde seulement ceux réellement vendables (availableForSale), et les préfixe.
async function boostNirvanaFiltersFirst(list) {
  let nirvana = [];
  try {
    const data = await fetchShopifyGraphQL(PRODUCTS_GQL, { q: "vendor:Nirvana AND title:filtre*", first: 8 });
    nirvana = (data.products?.edges || []).map(e => formatProduct(e.node))
      // garder SEULEMENT les unités de filtre (titre commençant par "filtre"/"filtreur"),
      // pas les accessoires Nirvana (cartouche de remplacement, verre de filtration, etc.)
      .filter(p => normalize(p.title).startsWith("filtre"));
  } catch (e) {
    return list;  // échec de la recherche ciblée → on garde l'ordre normal
  }
  const dispo = nirvana.filter(p => (p.variants || []).some(v => v.available));
  if (dispo.length === 0) return list;            // aucun Nirvana dispo → rien à prioriser
  const ids = new Set(dispo.map(p => p.id));
  const rest = list.filter(p => !ids.has(p.id));  // évite les doublons
  return [...dispo, ...rest];
}

// Génère un message en français pour expliquer à l'IA CE QU'ELLE VIENT DE TROUVER.
// L'IA va lire ce message et l'utiliser pour formuler sa réponse vocale au client.
function buildMessage({ count, level, widened }) {
  if (count === 0) {
    return "Aucun produit trouvé même après élargissement progressif. Demande au client de reformuler ou propose-lui des catégories générales (chimie, filtration, accessoires).";
  }
  if (!widened) {
    return `${count} produit(s) trouvé(s) avec les critères exacts demandés.`;
  }
  // Si on a élargi, on dit à l'IA POURQUOI (pour qu'elle puisse l'expliquer au client)
  const explain = {
    TOKENS:      "j'ai cherché chaque mot séparément",
    SYNONYMES:   "j'ai inclus les synonymes FR/EN et le vocabulaire technique",
    FILTERS_OFF: "j'ai retiré certains filtres (marque/type/stock) pour élargir",
    KEYWORD:     "j'ai gardé seulement le mot-clé principal",
    TAGS_ONLY:   "j'ai cherché uniquement dans les catégories/tags",
    FULLTEXT:    "j'ai fait une recherche libre sans aucune contrainte",
    FILTERS_ONLY:"je n'ai utilisé que les filtres fournis",
  }[level] || "j'ai élargi la recherche";
  return `${count} produit(s) trouvé(s) après élargissement (${explain}). Mentionne au client que tu as élargi la recherche pour trouver ces résultats.`;
}


// ╭───────────────────────────────────────────────────────────────────────╮
// │  12. ROUTE — POST /search_shopify_products                            │
// │       (Le tool que l'IA VAPI appelle pour chercher un produit)         │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Flow :
//   ① VAPI appelle cette URL avec { query: "filtre hayward", ... }
//   ② On lance la cascade de recherche
//   ③ On enregistre un événement (pour les stats du coach)
//   ④ On renvoie les produits formatés à VAPI

app.post("/search_shopify_products", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);
  const start = Date.now();  // chrono pour mesurer la latence

  try {
    // Validation : il faut au moins UN critère (sinon ça n'a pas de sens)
    const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
    const hasFilter = args.vendor || args.product_type || (Array.isArray(args.tags) && args.tags.length > 0);

    if (!hasQuery && !hasFilter) {
      return res.json(vapiResult(toolCallId, {
        count: 0,
        products: [],
        search_strategy_used: "NONE",
        widened: false,
        original_query: null,
        message: "Aucun critère de recherche fourni. Précise une description, une marque, un type ou des tags.",
      }));
    }

    // Normalisation des arguments fournis par l'IA (avec valeurs par défaut sûres)
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);   // entre 1 et 50, défaut 10
    const minPrice = typeof args.min_price === "number" ? args.min_price
                   : (args.min_price != null ? parseFloat(args.min_price) : null);
    const maxPrice = typeof args.max_price === "number" ? args.max_price
                   : (args.max_price != null ? parseFloat(args.max_price) : null);

    const searchArgs = {
      query: args.query || "",
      vendor: args.vendor || null,
      productType: args.product_type || null,
      tags: Array.isArray(args.tags) ? args.tags : null,
      minPrice: Number.isFinite(minPrice) ? minPrice : null,
      maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
      inStockOnly: !!args.in_stock_only,
      limit,
      widenIfEmpty: args.widen_if_empty !== false,  // défaut = true (on élargit)
    };

    // ⭐ Lancement de la cascade
    const { products, level, finalQuery, widened, debugTrace } = await cascadeSearch(searchArgs);
    let finalList = products.map(formatProduct);

    // in_stock_only : garder les produits réellement VENDABLES (availableForSale) ou
    // avec quantité suivie > 0 — au lieu de l'ancien filtre inventory_total:>0 qui
    // excluait l'inventaire non suivi mais disponible.
    if (searchArgs.inStockOnly) {
      finalList = finalList.filter(p =>
        (typeof p.total_inventory === "number" && p.total_inventory > 0) ||
        (p.variants || []).some(v => v.available)
      );
    }

    // Préférence marque : pour une recherche de FILTRE sans marque imposée — ni via le
    // filtre vendor, ni nommée dans la requête — remonter les filtres Nirvana
    // DISPONIBLES en premier (décision business).
    const qNorm = normalize(args.query || "");
    const clientNommeAutreMarque = OTHER_BRANDS.some(b => qNorm.includes(normalize(b)));
    if (/filtr|filter/.test(qNorm) && !searchArgs.vendor && !clientNommeAutreMarque) {  // « filtr » (FR) + « filter » (EN : ne contient PAS « filtr »)
      finalList = await boostNirvanaFiltersFirst(finalList);
    }

    const ms = Date.now() - start;

    console.log(`[search_shopify_products] level=${level} count=${finalList.length} ms=${ms}ms query="${finalQuery}"`);

    // Enregistre l'événement pour les stats du coach hebdo
    logEvent("shopify_product_search", {
      query: args.query || "",
      results_count: finalList.length,
      cascade_level: level,
      widened,
      ms,
    });

    // Réponse à l'IA
    const response = {
      count: finalList.length,
      products: finalList,
      search_strategy_used: level,
      widened,
      original_query: args.query || null,
      effective_filters: {
        vendor: searchArgs.vendor,
        product_type: searchArgs.productType,
        tags: searchArgs.tags,
        min_price: searchArgs.minPrice,
        max_price: searchArgs.maxPrice,
        in_stock_only: searchArgs.inStockOnly,
      },
      message: buildMessage({ count: finalList.length, level, widened }),
    };

    // Si 0 résultat, on inclut la trace de toutes les tentatives pour pouvoir débuger
    if (finalList.length === 0) {
      response.debug = debugTrace;
    }

    return res.json(vapiResult(toolCallId, response));
  } catch (err) {
    // Quelque chose a planté — on log et on renvoie un message d'erreur à l'IA
    const ms = Date.now() - start;
    console.error(`[search_shopify_products] ERROR after ${ms}ms:`, err);
    logEvent("error", { where: "search_shopify_products", message: err.message, ms });
    // ⚠️ On renvoie 200 OK (pas 500) avec l'erreur DANS la réponse, pour que
    // l'IA puisse l'expliquer au client au lieu de paniquer.
    return res.json(vapiResult(toolCallId, {
      count: 0,
      products: [],
      search_strategy_used: "ERROR",
      widened: false,
      original_query: args?.query || null,
      error: err.message,
      message: "Erreur technique lors de la recherche Shopify. Excuse-toi auprès du client et propose de réessayer.",
    }));
  }
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  12bis. CAPTURE DE LEADS — capture_lead                               │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// BUT : quand l'IA détecte un vrai prospect (projet d'envergure), elle appelle
// ce tool avec les coordonnées du client. On envoie un courriel instantané à
// REPORT_EMAIL_TO + logEvent pour que le coach hebdo compte les leads.
// Champs : name + phone (essentiels), project_type / budget / timeline / notes /
// email / channel (optionnels). Déclenchement piloté côté prompt VAPI.

async function sendLeadEmail(lead) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  if (!REPORT_EMAIL_TO) throw new Error("REPORT_EMAIL_TO missing");

  const nowHuman = new Date().toLocaleString("fr-CA", { timeZone: ANALYSIS_TIMEZONE });
  const row = (label, val) =>
    val ? `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;white-space:nowrap;">${escapeXml(label)}</td><td style="padding:4px 0;">${escapeXml(val)}</td></tr>` : "";

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;">
      <h2 style="color:#0a7a55;">🎯 Nouveau lead Barracuda</h2>
      <table style="border-collapse:collapse;font-size:15px;">
        ${row("Nom", lead.name)}
        ${row("Téléphone", lead.phone)}
        ${row("Courriel", lead.email)}
        ${row("Projet", lead.project_type)}
        ${row("Budget", lead.budget)}
        ${row("Délai", lead.timeline)}
        ${row("Notes", lead.notes)}
        ${row("Canal", lead.channel)}
        ${row("Reçu le", nowHuman)}
      </table>
      <p style="color:#888;font-size:12px;margin-top:16px;">
        Lead capturé automatiquement par l'assistant IA. Rappelle le client pour lui donner un estimé.
      </p>
    </div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: REPORT_EMAIL_FROM,
      to: [REPORT_EMAIL_TO],
      subject: `🎯 Nouveau lead — ${lead.name}${lead.project_type ? " (" + lead.project_type + ")" : ""}`,
      html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend API HTTP ${response.status}: ${text}`);
  }
}

app.post("/capture_lead", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);

  try {
    const name = (args.name || "").toString().trim();
    const phone = (args.phone || "").toString().trim();
    const lead = {
      name,
      phone,
      email: (args.email || "").toString().trim(),
      project_type: (args.project_type || "").toString().trim(),
      budget: (args.budget || "").toString().trim(),
      timeline: (args.timeline || "").toString().trim(),
      notes: (args.notes || "").toString().trim(),
      channel: (args.channel || "").toString().trim(),
    };

    // Validation : nom + téléphone obligatoires.
    if (!name || !phone) {
      return res.json(vapiResult(toolCallId, {
        ok: false,
        saved: false,
        message: "Information manquante. Redemande poliment au client son nom ET son numéro de téléphone avant d'enregistrer le lead.",
      }));
    }

    // Garde-fou : un numéro nord-américain a 10 chiffres. On refuse un numéro trop
    // court (transcription incomplète) pour ne pas enregistrer un lead inutilisable.
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      return res.json(vapiResult(toolCallId, {
        ok: false,
        saved: false,
        message: "Le numéro de téléphone semble incomplet (il faut au moins dix chiffres). Redemande au client son numéro, puis relis-le-lui chiffre par chiffre pour confirmation avant de l'enregistrer.",
      }));
    }

    // On log TOUJOURS l'événement (téléphone hashé) pour le coach hebdo.
    logEvent("lead_captured", {
      name,
      phone_hash: hashPhone(phone),
      project_type: lead.project_type || null,
      budget: lead.budget || null,
      timeline: lead.timeline || null,
      channel: lead.channel || null,
    });

    let emailed = false;
    try {
      await sendLeadEmail(lead);
      emailed = true;
      console.log(`[capture_lead] Lead emailed: ${name} / projet="${lead.project_type}"`);
    } catch (mailErr) {
      console.error("[capture_lead] Email failed:", mailErr.message);
      logEvent("error", { where: "capture_lead_email", message: mailErr.message });
    }

    return res.json(vapiResult(toolCallId, {
      ok: true,
      saved: true,
      emailed,
      message: "Lead enregistré. Confirme au client qu'un conseiller va le rappeler bientôt, et remercie-le.",
    }));
  } catch (err) {
    console.error("[capture_lead] ERROR:", err);
    logEvent("error", { where: "capture_lead", message: err.message });
    return res.json(vapiResult(toolCallId, {
      ok: false,
      saved: false,
      message: "Erreur technique en enregistrant les coordonnées. Demande au client de rappeler ou de passer au magasin.",
    }));
  }
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  12ter. PONT CUSTOM-LLM — Vapi (OpenAI) ↔ Claude (Anthropic)          │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// BUT : remplacer l'IA native de Vapi (gpt-4.1-mini) par CLAUDE, tout en
// gardant Vapi content. Vapi en mode `custom-llm` appelle CE endpoint au
// FORMAT OpenAI (POST /chat/completions, stream SSE) et attend une réponse au
// FORMAT OpenAI. Claude parle un autre dialecte (Messages API). Ce pont fait
// donc la TRADUCTION dans les deux sens, en temps réel.
//
//   Vapi ──(req OpenAI)──▶ ce pont ──(req Anthropic)──▶ Claude Haiku 4.5
//   Vapi ◀──(SSE OpenAI)── ce pont ◀──(SSE Anthropic)── Claude
//
// Les TOOL CALLS (search_shopify_products, etc.) sont RELAYÉS à Vapi au format
// OpenAI : Vapi appelle alors tes endpoints existants (/search_shopify_products
// …) puis renvoie le résultat dans le tour suivant. Tes 3 tools restent donc la
// seule source de vérité — rien n'est ré-implémenté ici.
//
// MODÈLE : Claude Haiku 4.5 (le plus rapide → meilleure latence vocale).

const CUSTOM_LLM_MODEL = "claude-haiku-4-5";
const CUSTOM_LLM_MAX_TOKENS = 1024;          // les réponses vocales sont courtes
const CUSTOM_LLM_TEMPERATURE = 0.3;          // aligné sur la config Vapi de Mathieu

// Parse JSON sans planter (les arguments de tool peuvent être "" ou partiels).
function safeJsonParse(str, fallback = {}) {
  if (str == null || str === "") return fallback;
  if (typeof str === "object") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Traduction REQUÊTE : format OpenAI (Vapi) → format Anthropic (Claude) ──
function openaiToAnthropic(body) {
  const systemParts = [];
  const messages = [];

  for (const msg of body.messages || []) {
    const role = msg.role;

    // 1) Les messages "system" d'OpenAI deviennent le champ `system` d'Anthropic.
    if (role === "system") {
      if (msg.content) systemParts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    // 2) Les résultats de tool ("tool" chez OpenAI) deviennent des blocs
    //    tool_result, regroupés dans un message "user" (exigence d'Anthropic).
    if (role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
      continue;
    }

    // 3) Message "user" simple.
    if (role === "user") {
      messages.push({ role: "user", content: typeof msg.content === "string" ? msg.content : (msg.content || "") });
      continue;
    }

    // 4) Message "assistant" : texte et/ou tool_calls → blocs Anthropic.
    if (role === "assistant") {
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name,
          input: safeJsonParse(tc.function?.arguments, {}),
        });
      }
      // Anthropic refuse un content vide : on met un espace si rien.
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: " " }] });
      continue;
    }
  }

  // ── Injection système GARANTIE PAR LE CODE ──
  // Recommandation des deux audits (8 juin 2026) : le custom-LLM est « la
  // solution structurelle définitive » aux dérives langue/montants → on force
  // ces règles dans le BACKEND, pas seulement dans le prompt Vapi. Ainsi elles
  // s'appliquent quel que soit le prompt envoyé par Vapi (et même si Haiku
  // dérape sous charge : prix collé au stock « 1199 100 », anglais parasite…).
  const isEN = /(-en|english)/i.test(body.model || "");
  systemParts.push(isEN
    ? `ABSOLUTE LANGUAGE RULE: always reply in English, 100%. The reference documents are in French — translate their content to English before answering.

NUMBERS AND PRICES (spoken, not written):
- Say every amount in words. Never read a raw-digit price. Never glue price and stock together (they are two distinct facts). If a price is over ten thousand dollars or marked unavailable, do NOT state it — say you'll confirm the exact price. Order numbers: digit by digit. Never read URLs, SKUs or tracking numbers aloud — offer to send them by SMS.

SPOKEN FORMAT — you are on the phone, not writing:
- NO emojis, NO markdown (no *, no #, no bullet lists). Natural spoken sentences only. Keep it short: one or two sentences, never a point-by-point list.`
    : `RÈGLE ABSOLUE DE LANGUE : réponds TOUJOURS en français québécois, à 100 %, même si un outil ou un nom de produit contient de l'anglais.

NOMBRES ET PRIX (tu parles, tu n'écris pas) :
- Dis tout montant en lettres : 11,99 $ → « onze dollars et quatre-vingt-dix-neuf ».
- Ne dis JAMAIS un prix en chiffres bruts (« 11 99 », « 1199 100 »).
- Ne colle JAMAIS le prix et le stock : ce sont deux infos distinctes.
- Si un prix dépasse dix mille dollars ou est marqué indisponible, ne l'annonce pas : dis que tu préfères confirmer le prix exact.
- Numéros de commande : chiffre par chiffre. N'énonce jamais les URLs, SKU ou numéros de suivi à voix haute — propose plutôt le SMS.

FORMAT PARLÉ — tu parles au téléphone, tu n'écris pas :
- AUCUN emoji, AUCUN markdown (pas de *, pas de #, pas de listes à puces). Que des phrases naturelles, comme à l'oral. Reste bref : une à deux phrases, jamais d'énumération en points.`);

  // Tools OpenAI → Anthropic.
  const tools = (body.tools || [])
    .filter(t => t.type === "function" && t.function?.name)
    .map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));

  // ⚠️ Anthropic EXIGE au moins un message, et que le PREMIER soit "user".
  // En mode "assistant parle en premier", Vapi n'envoie QUE le system au 1er
  // tour → messages vide → erreur 400 (cause de "custom-llm-llm-failed").
  // On injecte alors un déclencheur user pour que Claude génère son accueil.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: isEN ? "Hello" : "Bonjour" });
  }

  return {
    system: systemParts.join("\n\n"),
    messages,
    tools,
    // Clamp à 1 : OpenAI accepte 0–2 mais Anthropic refuse > 1 (HTTP 400 → custom-llm-llm-failed).
    temperature: Math.min(1, typeof body.temperature === "number" ? body.temperature : CUSTOM_LLM_TEMPERATURE),
    max_tokens: body.max_tokens || CUSTOM_LLM_MAX_TOKENS,
  };
}

// Mappe le stop_reason Anthropic → finish_reason OpenAI.
function mapFinishReason(stopReason) {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";  // end_turn, stop_sequence, etc.
}

// ── L'ENDPOINT custom-LLM ──
app.post("/chat/completions", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY missing" } });
  }

  const body = req.body || {};
  const wantsStream = body.stream !== false;          // Vapi custom-llm streame par défaut
  const echoModel = body.model || CUSTOM_LLM_MODEL;   // renvoyé tel quel dans les chunks
  const start = Date.now();

  const { system, messages, tools, temperature, max_tokens } = openaiToAnthropic(body);

  const anthropicBody = {
    model: CUSTOM_LLM_MODEL,
    max_tokens,
    temperature,
    messages,
    stream: wantsStream,
  };
  if (system) anthropicBody.system = system;
  if (tools.length) anthropicBody.tools = tools;

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    console.error("[custom-llm] fetch Anthropic failed:", err.message);
    return res.status(502).json({ error: { message: "Upstream Anthropic unreachable" } });
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    console.error(`[custom-llm] Anthropic HTTP ${upstream.status}: ${text.slice(0, 500)}`);
    return res.status(502).json({ error: { message: `Anthropic HTTP ${upstream.status}` } });
  }

  const chatId = "chatcmpl-" + Date.now();
  const created = Math.floor(Date.now() / 1000);

  // ── Chemin NON-STREAM (rare avec Vapi, mais on le gère proprement) ──
  if (!wantsStream) {
    const data = await upstream.json();
    let textOut = "";
    const toolCalls = [];
    for (const block of data.content || []) {
      if (block.type === "text") textOut += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      }
    }
    const message = { role: "assistant", content: textOut || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    console.log(`[custom-llm] non-stream done in ${Date.now() - start}ms (tools=${toolCalls.length})`);
    return res.json({
      id: chatId, object: "chat.completion", created, model: echoModel,
      choices: [{ index: 0, message, finish_reason: mapFinishReason(data.stop_reason) }],
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : undefined,
    });
  }

  // ── Chemin STREAM : on re-streame les chunks Anthropic en chunks OpenAI ──
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const sendChunk = (delta, finish_reason = null) => {
    const chunk = {
      id: chatId, object: "chat.completion.chunk", created, model: echoModel,
      choices: [{ index: 0, delta, finish_reason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  sendChunk({ role: "assistant", content: "" });  // premier chunk = le rôle (convention OpenAI)

  const blockTypeByIndex = {};   // index de bloc Anthropic → "text" | "tool_use"
  const toolIdxByBlock = {};     // index de bloc Anthropic → index OpenAI du tool_call
  let toolCounter = -1;
  let stopReason = "end_turn";
  let buffer = "";

  const handleEvent = (json) => {
    switch (json.type) {
      case "content_block_start": {
        const cb = json.content_block || {};
        blockTypeByIndex[json.index] = cb.type;
        if (cb.type === "tool_use") {
          toolCounter += 1;
          toolIdxByBlock[json.index] = toolCounter;
          sendChunk({ tool_calls: [{
            index: toolCounter, id: cb.id, type: "function",
            function: { name: cb.name, arguments: "" },
          }] });
        }
        break;
      }
      case "content_block_delta": {
        const d = json.delta || {};
        if (d.type === "text_delta") {
          sendChunk({ content: d.text });
        } else if (d.type === "input_json_delta") {
          sendChunk({ tool_calls: [{
            index: toolIdxByBlock[json.index],
            function: { arguments: d.partial_json || "" },
          }] });
        }
        break;
      }
      case "message_delta":
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
        break;
    }
  };

  try {
    // node-fetch v3 : response.body est un Readable Node → on itère les buffers,
    // on accumule et on découpe les lignes SSE "data: {...}".
    for await (const chunk of upstream.body) {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.type === "error") {
          console.error("[custom-llm] Anthropic stream error:", JSON.stringify(json.error));
          continue;
        }
        handleEvent(json);
      }
    }

    sendChunk({}, mapFinishReason(stopReason));
    res.write("data: [DONE]\n\n");
    res.end();
    console.log(`[custom-llm] stream done in ${Date.now() - start}ms (stop=${stopReason}, tools=${toolCounter + 1})`);
  } catch (err) {
    console.error("[custom-llm] stream relay error:", err.message);
    try {
      sendChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    } catch { /* connexion déjà coupée */ }
  }
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  12quater. SMS SORTANT — /send-sms + tool Vapi send_sms              │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// BUT : permettre au backend ET à l'IA Vapi d'ENVOYER des SMS via Twilio.
// Usages :
//   • « oui → SMS immédiat » de l'accueil : le client dit oui → l'IA appelle le
//     tool Vapi `send_sms` → on envoie le SMS de bienvenue tout de suite.
//   • Tout suivi / lien envoyé par texto pendant ou après l'appel.
//
// Deux entrées :
//   • POST /send-sms        → JSON simple { to, body }  (usage direct / test)
//   • POST /send_sms_tool   → format tool Vapi (le numéro de l'appelant est
//                              récupéré automatiquement si l'IA ne fournit pas `to`)

// Normalise un numéro en E.164 nord-américain (Twilio l'exige : +1XXXXXXXXXX).
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.startsWith("+")) return s.replace(/[^\d+]/g, "");      // déjà E.164
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;             // 10 chiffres → +1
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;                                                // format inconnu
}

// Envoie un SMS via l'API REST Twilio. Renvoie { success, message_id, to }.
async function sendSmsViaTwilio(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN manquants");
  if (!TWILIO_SMS_FROM) throw new Error("TWILIO_SMS_FROM manquant (numéro expéditeur)");
  const toE = toE164(to);
  if (!toE) throw new Error(`Numéro destinataire invalide: "${to}"`);
  if (!body || !String(body).trim()) throw new Error("Corps du SMS vide");

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams({ To: toE, From: TWILIO_SMS_FROM, Body: String(body) });

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Twilio HTTP ${resp.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return { success: true, message_id: data.sid, to: toE };
}

// ── Endpoint JSON simple : POST /send-sms  { to, body } ──
app.post("/send-sms", async (req, res) => {
  const { to, body } = req.body || {};
  try {
    const result = await sendSmsViaTwilio(to, body);
    logEvent("sms_sent", { to_hash: hashPhone(result.to), via: "send-sms", chars: (body || "").length });
    console.log(`[send-sms] envoyé à ${result.to} (sid=${result.message_id})`);
    return res.json(result);
  } catch (err) {
    console.error("[send-sms] ERREUR:", err.message);
    logEvent("error", { where: "send-sms", message: err.message });
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ── Tool Vapi : POST /send_sms_tool (format tool VAPI) ──
// L'IA fournit `body` (le texte). `to` est optionnel : si absent, on prend le
// numéro de l'appelant depuis l'enveloppe Vapi (le plus fiable en vocal).
app.post("/send_sms_tool", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);
  const callerNumber = req.body?.message?.call?.customer?.number || null;
  const to = args.to || callerNumber;
  const body = args.body || args.message || WELCOME_SMS_TEXT;   // défaut = SMS de bienvenue

  try {
    const result = await sendSmsViaTwilio(to, body);
    logEvent("sms_sent", { to_hash: hashPhone(result.to), via: "vapi_tool", chars: String(body).length });
    console.log(`[send_sms_tool] envoyé à ${result.to} (sid=${result.message_id})`);
    return res.json(vapiResult(toolCallId, {
      ok: true,
      sent: true,
      message: "SMS envoyé avec succès. Confirme-le au client à voix haute, puis poursuis la conversation.",
    }));
  } catch (err) {
    console.error("[send_sms_tool] ERREUR:", err.message);
    logEvent("error", { where: "send_sms_tool", message: err.message });
    return res.json(vapiResult(toolCallId, {
      ok: false,
      sent: false,
      message: "Je n'ai pas réussi à envoyer le SMS. Excuse-toi auprès du client et propose de réessayer ou de noter son numéro.",
    }));
  }
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  13. PONT SMS — Twilio ↔ VAPI Chat                                    │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// FLOW COMPLET :
//   ① Un client envoie un SMS à notre numéro Twilio
//   ② Twilio détecte le SMS et fait un POST sur /sms/incoming
//   ③ On envoie le texte du SMS à l'API VAPI Chat (qui utilise l'assistant FR)
//   ④ VAPI répond avec un message (l'IA peut appeler les tools Shopify aussi !)
//   ⑤ On renvoie la réponse à Twilio au format TwiML (XML)
//   ⑥ Twilio envoie le SMS de réponse au client
//
// CONFIG TWILIO REQUISE :
//   Phone Numbers → ton numéro → Messaging → "A message comes in" →
//   Webhook → URL = https://barracuda-ai-agent-production-806d.up.railway.app/sms/incoming
//   Method = POST

// Durée de vie d'une session : 1 heure. Au-delà, on considère la conversation
// terminée et on en démarre une nouvelle si le client renvoie un SMS.
const SMS_SESSION_TTL_MS = 60 * 60 * 1000;

// Stockage en mémoire des sessions actives : numéro → { id de chat VAPI, dernière interaction }
const smsSessions = new Map();

// Récupère la session d'un numéro, ou null si elle n'existe pas / est expirée
function getSmsSession(phone) {
  const s = smsSessions.get(phone);
  if (!s) return null;
  // Expirée ? On supprime et on renvoie null
  if (Date.now() - s.lastSeen > SMS_SESSION_TTL_MS) {
    smsSessions.delete(phone);
    return null;
  }
  return s;
}

// Sauvegarde/met à jour la session pour un numéro
function setSmsSession(phone, chatId) {
  smsSessions.set(phone, { previousChatId: chatId, lastSeen: Date.now() });
}

// Échappe les caractères spéciaux pour pouvoir mettre le texte dans du XML (TwiML)
// Sinon un texte avec « < » ou « & » casserait le XML
function escapeXml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Appelle l'API VAPI Chat avec le texte du client.
// Si on a un previousChatId (= conversation déjà entamée), on le passe pour
// maintenir le contexte (l'IA se souvient des SMS précédents).
async function vapiChat(message, previousChatId = null, channel = "sms") {
  if (!VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
    throw new Error("VAPI credentials missing (VAPI_PRIVATE_KEY / VAPI_ASSISTANT_ID)");
  }

  // On injecte le canal directement dans le texte du message d'entrée.
  // Pourquoi pas via assistantOverrides.variableValues : VAPI Chat n'applique
  // pas les overrides quand on continue une session avec previousChatId
  // (les overrides du 1er call sont figés). Le préfixe inline est garanti
  // d'arriver à l'agent dans son contexte de la conversation courante.
  const channelHint = channel === "sms"
    ? "[CANAL: SMS — tu communiques par texto, pas par voix]\n\n"
    : "";

  const body = {
    assistantId: VAPI_ASSISTANT_ID,
    input: channelHint + message,
  };
  if (previousChatId) body.previousChatId = previousChatId;

  const response = await fetch("https://api.vapi.ai/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VAPI Chat HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();

  // ⚠️ PIÈGE CRITIQUE : VAPI Chat renvoie PLUSIEURS messages dans output[].
  // Souvent il y a la firstMessage de l'assistant (« Bonjour, ici Barracuda... »)
  // ET la vraie réponse à la question du user. On veut LA VRAIE RÉPONSE, donc
  // on prend TOUJOURS le DERNIER message assistant.
  let reply = "";

  if (Array.isArray(data.output) && data.output.length > 0) {
    const assistantMsgs = data.output.filter(m => m?.role === "assistant");
    reply = assistantMsgs[assistantMsgs.length - 1]?.content || "";
  }

  // Fallback : si le format est différent (champ "messages" au lieu de "output")
  if (!reply && Array.isArray(data.messages) && data.messages.length > 0) {
    const assistantMsgs = data.messages.filter(m => m?.role === "assistant");
    reply = assistantMsgs[assistantMsgs.length - 1]?.content || "";
  }

  // Dernier fallback : champs directs "message" ou "content"
  if (!reply) {
    reply = data.message || data.content || "";
  }

  return { chatId: data.id, reply, raw: data };
}

// Endpoint webhook Twilio — c'est ICI qu'arrivent les SMS entrants
app.post("/sms/incoming", async (req, res) => {
  // Twilio envoie ces données en form-urlencoded
  const from = req.body?.From;             // numéro du client
  const to = req.body?.To;                 // notre numéro
  const body = req.body?.Body;             // contenu du SMS
  const sid = req.body?.MessageSid;        // identifiant Twilio du SMS
  const smsStart = Date.now();
  const phoneHash = hashPhone(from);       // hash anonymisé du numéro

  console.log(`[sms] incoming from=${from} to=${to} sid=${sid} body="${body}"`);

  // Twilio attend une réponse au format TwiML (XML) — on le déclare dès le début
  res.set("Content-Type", "text/xml; charset=utf-8");

  // SMS vide ? On accuse réception sans répondre (évite de spammer)
  if (!from || !body || !body.trim()) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }

  try {
    // On regarde si le client a déjà une conversation en cours
    const session = getSmsSession(from);
    console.log(`[sms] session_lookup phone=${from} previous_chat_id=${session?.previousChatId || "NONE (new conversation)"}`);

    // Log l'événement « SMS reçu » pour le coach hebdo
    logEvent("sms_received", {
      phone_hash: phoneHash,
      body_len: body.length,
      is_new_session: !session,
    });

    // ⭐ Appel à VAPI Chat avec la continuité de conversation
    const { chatId, reply } = await vapiChat(body.trim(), session?.previousChatId);
    if (chatId) setSmsSession(from, chatId);   // on sauvegarde la session

    // Si VAPI a renvoyé une réponse vide pour une raison X, on a un fallback
    const finalReply = (reply && reply.trim())
      || "Désolé, je n'ai pas saisi votre message. Pouvez-vous reformuler? / Sorry, I didn't catch that. Could you rephrase?";

    console.log(`[sms] reply to ${from} new_chatId=${chatId} reply="${finalReply.slice(0, 100)}..."`);

    // Log « SMS répondu » avec la latence
    logEvent("sms_replied", {
      phone_hash: phoneHash,
      latency_ms: Date.now() - smsStart,
      reply_len: finalReply.length,
    });

    // Réponse à Twilio au format TwiML — Twilio enverra ce texte au client
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(finalReply)}</Message></Response>`
    );
  } catch (err) {
    console.error(`[sms] ERROR for ${from}:`, err);
    logEvent("error", {
      where: "sms_incoming",
      message: err.message,
      phone_hash: phoneHash,
      latency_ms: Date.now() - smsStart,
    });
    // En cas d'erreur, on envoie un message générique au client (au lieu de rien)
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(
        "Désolé, erreur technique. Réessayez dans un instant ou appelez-nous au magasin."
      )}</Message></Response>`
    );
  }
});

// Endpoint diagnostic — visite l'URL dans un navigateur pour tester VAPI Chat
// sans passer par Twilio. Tu peux ajouter ?msg=ton+message pour tester un message custom.
app.get("/diagnose-sms", async (req, res) => {
  const msg = req.query.msg || "Avez-vous un filtre Hayward en stock?";
  try {
    const { chatId, reply, raw } = await vapiChat(msg);
    res.json({
      ok: true,
      input_sent: msg,
      vapi_assistant_id: VAPI_ASSISTANT_ID,
      vapi_chat_id: chatId,
      parsed_reply: reply,
      sessions_active: smsSessions.size,
      raw_response: raw,   // structure complète, utile pour debug
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ╔════════════════════════════════════════════════════════════════════════╗
// ║                                                                        ║
// ║   COACH IA HEBDO — Analyse automatique des appels                      ║
// ║                                                                        ║
// ║   À QUOI ÇA SERT :                                                     ║
// ║   Chaque dimanche à 23h (heure de Toronto), le serveur :               ║
// ║   ① récupère TOUS les appels VAPI de la semaine                        ║
// ║   ② calcule des statistiques (volume, durée, langue, etc.)             ║
// ║   ③ garde seulement les appels « intéressants » (trop courts,          ║
// ║      trop longs, erreurs, ou contenant « je ne sais pas »)             ║
// ║   ④ envoie ces appels à Claude (l'IA d'Anthropic) qui les analyse      ║
// ║      et identifie les problèmes + propose des fixes concrets           ║
// ║   ⑤ envoie un rapport courriel HTML à toi (REPORT_EMAIL_TO)            ║
// ║                                                                        ║
// ║   DÉCLENCHEMENTS :                                                     ║
// ║   • Automatique : tous les dimanches 23h (via setInterval ci-dessous)  ║
// ║   • Manuel : POST /weekly-analysis?secret=<ANALYSIS_SECRET>            ║
// ║                                                                        ║
// ╚════════════════════════════════════════════════════════════════════════╝

// --- ÉTAPE 1. Récupérer les appels VAPI de la semaine ---
async function fetchVapiCalls(startDate, endDate) {
  const url = `https://api.vapi.ai/call?createdAtGe=${startDate.toISOString()}&createdAtLe=${endDate.toISOString()}&limit=1000`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`VAPI Calls API HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();
  // VAPI peut renvoyer soit un tableau direct, soit { calls: [...] } — on gère les deux
  return Array.isArray(data) ? data : (data.calls || []);
}

// --- ÉTAPE 2. Pré-filtrage : on ne garde que les appels « intéressants »
// (Inutile d'envoyer à Claude un appel parfait — ça coûte des tokens pour rien)
function isInterestingCall(call) {
  const durationSec = call.endedAt && call.startedAt
    ? (new Date(call.endedAt) - new Date(call.startedAt)) / 1000
    : 0;

  // Critères d'« intéressant » :
  if (durationSec < 30) return true;                               // < 30s = client a raccroché vite (problème ?)
  if (durationSec > 300) return true;                              // > 5 min = client s'enlise
  if (call.endedReason && /error|failed|timeout/i.test(call.endedReason)) return true;  // raison de fin suspecte
  if (call.status === "failed") return true;                       // appel marqué « failed »

  // Le transcript contient-il des signaux d'échec de l'IA ?
  const transcript = (call.transcript || "").toLowerCase();
  if (/je ne sais pas|je ne trouve pas|désolé|i don'?t know|sorry/i.test(transcript)) return true;

  return false;  // tout va bien, on n'envoie pas cet appel à Claude
}

// Réduit l'objet « appel » à l'essentiel, pour économiser des tokens Claude
function compactCallForAnalysis(call) {
  return {
    id: call.id,
    assistant_id: call.assistantId || null,
    assistant_name: VAPI_ASSISTANTS_MAP[call.assistantId] || null,  // « Accueil » / « FR » / « EN »
    started_at: call.startedAt || null,
    duration_sec: call.endedAt && call.startedAt
      ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
      : null,
    ended_reason: call.endedReason || null,
    transcript: call.transcript || "",
    tool_calls_made: (call.messages || [])
      .filter(m => m.role === "tool_calls" || m.toolCalls)
      .map(m => m.toolCalls?.[0]?.function?.name || m.name)
      .filter(Boolean),
  };
}

// --- Stats agrégées calculées DEPUIS la liste brute des appels VAPI ---
// (Volume, durée, split par assistant FR/EN/Accueil, raisons de fin, heures de pic)
function computeCallStats(allCalls) {
  const total = allCalls.length;

  // Cas spécial : aucun appel → on renvoie un objet vide bien formé
  if (total === 0) {
    return {
      total_calls: 0,
      avg_duration_sec: 0,
      total_duration_sec: 0,
      by_assistant: {},
      by_ended_reason: {},
      by_hour_local: {},
      short_calls_under_30s: 0,
      long_calls_over_5min: 0,
    };
  }

  // On boucle sur les appels et on accumule les compteurs
  const durations = [];
  const byAssistant = {};      // ex: { "FR": 12, "EN": 3, "Accueil": 1 }
  const byEndedReason = {};    // ex: { "customer-ended-call": 15, "error": 1 }
  const byHour = {};           // ex: { 9: 2, 10: 5, 14: 3 } — heure de la journée
  let short30 = 0;
  let long5 = 0;

  for (const c of allCalls) {
    // Durée de l'appel en secondes
    const dur = c.endedAt && c.startedAt
      ? (new Date(c.endedAt) - new Date(c.startedAt)) / 1000
      : 0;
    if (dur > 0) durations.push(dur);
    if (dur > 0 && dur < 30) short30++;
    if (dur > 300) long5++;

    // Compteur par assistant (avec nom lisible si on a le mapping)
    const aName = VAPI_ASSISTANTS_MAP[c.assistantId] || c.assistantId || "unknown";
    byAssistant[aName] = (byAssistant[aName] || 0) + 1;

    // Compteur par raison de fin d'appel
    const reason = c.endedReason || "unknown";
    byEndedReason[reason] = (byEndedReason[reason] || 0) + 1;

    // Heure locale (Toronto) à laquelle l'appel a commencé
    if (c.startedAt) {
      try {
        const local = new Date(new Date(c.startedAt).toLocaleString("en-US", { timeZone: ANALYSIS_TIMEZONE }));
        const hour = local.getHours();
        byHour[hour] = (byHour[hour] || 0) + 1;
      } catch { /* date corrompue, on skip */ }
    }
  }

  // Moyenne et total
  const totalDur = durations.reduce((a, b) => a + b, 0);
  const avgDur = durations.length > 0 ? totalDur / durations.length : 0;

  return {
    total_calls: total,
    avg_duration_sec: Math.round(avgDur),
    total_duration_sec: Math.round(totalDur),
    by_assistant: byAssistant,
    by_ended_reason: byEndedReason,
    by_hour_local: byHour,
    short_calls_under_30s: short30,
    long_calls_over_5min: long5,
  };
}

// --- Stats agrégées calculées DEPUIS les events in-memory ---
// (Top requêtes Shopify, requêtes sans résultat = synonymes manquants, SMS, erreurs)
function computeEventStats(events) {
  // On découpe la liste d'events par type
  const productSearches = events.filter(e => e.type === "shopify_product_search");
  const orderSearches = events.filter(e => e.type === "shopify_order_search");
  const smsReceived = events.filter(e => e.type === "sms_received");
  const smsReplied = events.filter(e => e.type === "sms_replied");
  const errors = events.filter(e => e.type === "error");

  // Top requêtes Shopify (= mots les plus cherchés)
  const queryCount = {};
  const cascadeLevelCount = {};
  let zeroResultQueries = [];
  for (const e of productSearches) {
    const q = (e.query || "").trim().toLowerCase();
    if (q) queryCount[q] = (queryCount[q] || 0) + 1;
    cascadeLevelCount[e.cascade_level] = (cascadeLevelCount[e.cascade_level] || 0) + 1;
    // Une requête avec 0 résultat = candidat « synonyme manquant »
    if (e.results_count === 0 && q) zeroResultQueries.push(q);
  }

  // Compte combien de fois chaque requête « zéro résultat » est revenue
  const zeroResultCount = {};
  for (const q of zeroResultQueries) zeroResultCount[q] = (zeroResultCount[q] || 0) + 1;

  // Top 20 requêtes les plus fréquentes
  const topQueries = Object.entries(queryCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  // Top 15 requêtes « zéro résultat » (= synonymes à ajouter en priorité)
  const topZeroResultQueries = Object.entries(zeroResultCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([query, count]) => ({ query, count }));

  // Stats SMS : numéros uniques, nouvelles sessions, latence moyenne
  const uniquePhones = new Set(smsReceived.map(e => e.phone_hash).filter(Boolean));
  const newSessions = smsReceived.filter(e => e.is_new_session).length;
  const latencies = smsReplied.map(e => e.latency_ms).filter(n => typeof n === "number");
  const avgSmsLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  // Commandes : combien ont été trouvées vs non trouvées
  const ordersFound = orderSearches.filter(e => e.found).length;

  // Erreurs par endroit (où elles se sont produites)
  const errorsByWhere = {};
  for (const e of errors) {
    const w = e.where || "unknown";
    errorsByWhere[w] = (errorsByWhere[w] || 0) + 1;
  }

  return {
    product_searches: {
      total: productSearches.length,
      top_queries: topQueries,
      top_zero_result_queries: topZeroResultQueries,
      cascade_level_distribution: cascadeLevelCount,
    },
    order_searches: {
      total: orderSearches.length,
      found: ordersFound,
      not_found: orderSearches.length - ordersFound,
    },
    sms: {
      received: smsReceived.length,
      replied: smsReplied.length,
      unique_phones: uniquePhones.size,
      new_sessions: newSessions,
      avg_latency_ms: avgSmsLatency,
    },
    errors: {
      total: errors.length,
      by_where: errorsByWhere,
    },
  };
}

// --- ÉTAPE 3. Analyse par Claude Sonnet 4.6 ---

// Prompt système : le rôle et les règles que Claude doit suivre
const COACH_SYSTEM_PROMPT = `Tu es un coach IA expert pour Barracuda Piscines & Spas, un magasin de piscines et spas à Gatineau, Québec.

Tu analyses les transcripts d'appels et SMS de la semaine de leur agent vocal IA bilingue (FR/EN) qui :
- Répond aux appels téléphoniques entrants et aux SMS
- A accès à 2 tools : search_shopify_products (recherche catalogue) et search_shopify_orders (suivi commandes par n°)
- A 11 fichiers de knowledge (eau verte, pH, filtres, spa, liner, fibre de verre, etc.)
- Suit un prompt qui demande : réponses courtes, une question à la fois, prix en lettres françaises complètes, ne jamais dire qu'un produit n'existe pas avant d'avoir cherché Shopify, redirige vers magasin/courriel pour les demandes humaines

Ton job : identifier ce qui ne va PAS et proposer des fixes CONCRETS et APPLICABLES immédiatement.

Tu DOIS appeler l'outil submit_weekly_report avec ton analyse complète. C'est le SEUL moyen de soumettre ton rapport.

Règles :
- Maximum 5 entrées dans top_issues, classées par fréquence/impact
- Maximum 10 missing_synonyms
- Sois CONCRET : « ajoute "filtreur" comme synonyme de "filtre" dans Ai.js ligne ~120 » plutôt que « améliorer la recherche »
- Si rien d'alarmant : appelle quand même submit_weekly_report avec top_issues vide et wins remplis
- N'invente RIEN. Si tu ne vois pas un pattern dans les transcripts fournis, ne le mentionne pas.`;

// Schéma du tool que Claude DOIT appeler pour soumettre son rapport.
// On force l'utilisation de ce tool (via tool_choice) pour garantir un JSON valide.
const COACH_TOOL_SCHEMA = {
  name: "submit_weekly_report",
  description: "Soumet le rapport hebdomadaire d'analyse des appels VAPI",
  input_schema: {
    type: "object",
    required: ["period", "total_calls_analyzed", "global_summary", "top_issues", "missing_synonyms", "knowledge_gaps", "hallucinations_detected", "wins"],
    properties: {
      period: { type: "string", description: "Période analysée au format YYYY-MM-DD → YYYY-MM-DD" },
      total_calls_analyzed: { type: "integer", description: "Nombre d'appels examinés en détail" },
      global_summary: { type: "string", description: "1-2 phrases résumant l'état général de la semaine" },
      top_issues: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["rank", "issue", "frequency", "example_transcript_excerpt", "root_cause", "proposed_fix", "fix_location"],
          properties: {
            rank: { type: "integer" },
            issue: { type: "string", description: "Description courte du problème" },
            frequency: { type: "string", description: "Ex: '4 appels concernés'" },
            example_transcript_excerpt: { type: "string", description: "Court extrait illustrant le problème" },
            root_cause: { type: "string", description: "Pourquoi ça arrive" },
            proposed_fix: { type: "string", description: "Action précise à prendre" },
            fix_location: { type: "string", description: "Où appliquer le fix: prompt FR | prompt EN | Ai.js synonymes | knowledge file: nom.txt" }
          }
        }
      },
      missing_synonyms: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          required: ["word_heard", "should_match", "context"],
          properties: {
            word_heard: { type: "string", description: "Mot prononcé par le client" },
            should_match: { type: "string", description: "Mot du catalogue que ça devrait matcher" },
            context: { type: "string", description: "Ex: 'recherche pompe'" }
          }
        }
      },
      knowledge_gaps: {
        type: "array",
        items: { type: "string", description: "Question/sujet absent de la knowledge base" }
      },
      hallucinations_detected: {
        type: "array",
        items: {
          type: "object",
          required: ["what_was_said", "why_problematic"],
          properties: {
            transcript_id: { type: "string" },
            what_was_said: { type: "string" },
            why_problematic: { type: "string" }
          }
        }
      },
      wins: {
        type: "array",
        items: { type: "string", description: "Comportements positifs à conserver" }
      }
    }
  }
};

// Fonction qui envoie les appels à Claude et récupère son analyse
async function analyzeWithClaude(calls, statsContext = null) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");

  // Si on a des stats, on les passe à Claude pour qu'il croise « stats objectives » + transcripts
  const statsBlock = statsContext
    ? `\nMÉTRIQUES OBJECTIVES DE LA SEMAINE (toute la base, pas juste les appels ci-dessous) :
${JSON.stringify(statsContext, null, 2)}

Utilise ces métriques pour contextualiser ton analyse. Par exemple : si "top_zero_result_queries" contient "filtreur" 6 fois, c'est probablement un synonyme manquant majeur.\n`
    : "";

  // Message utilisateur : on liste les transcripts un par un
  const userMessage = `Voici ${calls.length} transcripts d'appels intéressants de la semaine écoulée. Analyse-les et produis le rapport JSON.
${statsBlock}
${calls.map((c, i) => `--- APPEL ${i + 1} (id: ${c.id}, assistant: ${c.assistant_name || c.assistant_id || "?"}, durée: ${c.duration_sec}s, fin: ${c.ended_reason}, tools: ${c.tool_calls_made.join(", ") || "aucun"}) ---
${c.transcript}
`).join("\n\n")}`;

  // Appel à l'API Anthropic
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: COACH_SYSTEM_PROMPT,
      tools: [COACH_TOOL_SCHEMA],
      // On FORCE Claude à appeler ce tool spécifique — sinon il pourrait répondre en texte libre
      tool_choice: { type: "tool", name: "submit_weekly_report" },
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();

  // Avec tool_use forcé, Claude DOIT avoir appelé submit_weekly_report.
  // On trouve le bloc « tool_use » dans sa réponse et on extrait son input.
  const toolUseBlock = (data.content || []).find(
    b => b.type === "tool_use" && b.name === "submit_weekly_report"
  );

  if (!toolUseBlock || !toolUseBlock.input) {
    throw new Error(`Claude n'a pas appelé submit_weekly_report. Réponse brute: ${JSON.stringify(data.content).slice(0, 800)}`);
  }

  const report = toolUseBlock.input;

  // Calcul du coût en USD (Sonnet 4.6 = $3/M input, $15/M output)
  const cost_usd = data.usage
    ? ((data.usage.input_tokens * 3 + data.usage.output_tokens * 15) / 1_000_000)
    : null;

  return { report, cost_usd, raw_text: JSON.stringify(data.content) };
}

// --- ÉTAPE 4. Formatage HTML du rapport (pour le courriel) ---
function reportToHtml(report, meta) {
  // Helper interne pour échapper le HTML (sécurité contre injection)
  const escapeHtml = s => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Liste des problèmes identifiés
  const issuesList = (report.top_issues || []).map(i => `
    <li style="margin-bottom: 16px;">
      <strong>#${escapeHtml(i.rank)} — ${escapeHtml(i.issue)}</strong> <em>(${escapeHtml(i.frequency)})</em><br>
      <strong>Cause :</strong> ${escapeHtml(i.root_cause)}<br>
      <strong>Fix proposé :</strong> ${escapeHtml(i.proposed_fix)}<br>
      <strong>Où appliquer :</strong> <code>${escapeHtml(i.fix_location)}</code><br>
      <em>Extrait :</em> ${escapeHtml(i.example_transcript_excerpt)}
    </li>`).join("");

  // Liste des synonymes manquants
  const synonymsList = (report.missing_synonyms || []).map(s =>
    `<li><code>${escapeHtml(s.word_heard)}</code> → <code>${escapeHtml(s.should_match)}</code> (${escapeHtml(s.context)})</li>`
  ).join("");

  const gapsList = (report.knowledge_gaps || []).map(g => `<li>${escapeHtml(g)}</li>`).join("");
  const winsList = (report.wins || []).map(w => `<li>${escapeHtml(w)}</li>`).join("");

  // ─── Section MÉTRIQUES (générée si meta.stats existe) ───
  const stats = meta.stats || null;
  let metricsHtml = "";
  if (stats) {
    const c = stats.calls;
    const e = stats.events;

    // Tableau « par assistant »
    const assistantRows = Object.entries(c.by_assistant || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `<li>${escapeHtml(name)} : <strong>${n}</strong> appel(s)</li>`).join("");

    // Tableau « raisons de fin »
    const reasonRows = Object.entries(c.by_ended_reason || {})
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `<li><code>${escapeHtml(reason)}</code> : ${n}</li>`).join("");

    // Top 5 heures de pic
    const peakHours = Object.entries(c.by_hour_local || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([h, n]) => `${h}h : ${n}`).join(" · ");

    // Tableau des requêtes Shopify
    const topQ = (e.product_searches?.top_queries || [])
      .map(q => `<li><code>${escapeHtml(q.query)}</code> — ${q.count}×</li>`).join("");
    const zeroQ = (e.product_searches?.top_zero_result_queries || [])
      .map(q => `<li><code>${escapeHtml(q.query)}</code> — ${q.count}× <em>(0 résultat)</em></li>`).join("");
    const cascade = Object.entries(e.product_searches?.cascade_level_distribution || {})
      .map(([lvl, n]) => `<code>${escapeHtml(lvl)}</code>: ${n}`).join(" · ");

    // Tableau des erreurs
    const errorRows = Object.entries(e.errors?.by_where || {})
      .map(([where, n]) => `<li><code>${escapeHtml(where)}</code> : ${n}</li>`).join("");

    metricsHtml = `
      <h2>📊 Métriques de la semaine</h2>

      <h3 style="margin-bottom:4px;">📞 Appels VAPI</h3>
      <p style="margin-top:0;">
        <strong>${c.total_calls}</strong> appels totaux ·
        durée moy. <strong>${c.avg_duration_sec}s</strong> ·
        temps total ${Math.round(c.total_duration_sec / 60)} min<br>
        ${c.short_calls_under_30s} appels &lt;30s (raccrochage rapide) ·
        ${c.long_calls_over_5min} appels &gt;5min (client s'enlise)
      </p>
      ${assistantRows ? `<p style="margin:4px 0;"><strong>Par assistant :</strong></p><ul style="margin-top:0;">${assistantRows}</ul>` : ""}
      ${reasonRows ? `<p style="margin:4px 0;"><strong>Raisons de fin :</strong></p><ul style="margin-top:0;">${reasonRows}</ul>` : ""}
      ${peakHours ? `<p><strong>Heures de pic (TZ ${escapeHtml(ANALYSIS_TIMEZONE)}) :</strong> ${peakHours}</p>` : ""}

      <h3 style="margin-bottom:4px;">🔍 Recherches Shopify</h3>
      <p style="margin-top:0;">
        <strong>${e.product_searches?.total || 0}</strong> recherches produits ·
        <strong>${e.order_searches?.total || 0}</strong> recherches commandes
        (${e.order_searches?.found || 0} trouvées / ${e.order_searches?.not_found || 0} non trouvées)
      </p>
      ${cascade ? `<p><strong>Niveaux de cascade :</strong> ${cascade}</p>` : ""}
      ${topQ ? `<p style="margin:4px 0;"><strong>Top requêtes :</strong></p><ul style="margin-top:0;">${topQ}</ul>` : ""}
      ${zeroQ ? `<p style="margin:4px 0;"><strong>⚠️ Requêtes sans résultat (= synonymes manquants ?) :</strong></p><ul style="margin-top:0;">${zeroQ}</ul>` : ""}

      <h3 style="margin-bottom:4px;">💬 SMS</h3>
      <p style="margin-top:0;">
        ${e.sms?.received || 0} SMS reçus ·
        ${e.sms?.unique_phones || 0} numéros uniques ·
        ${e.sms?.new_sessions || 0} nouvelles sessions ·
        latence moy. ${e.sms?.avg_latency_ms || 0}ms
      </p>

      ${e.errors?.total > 0 ? `
      <h3 style="margin-bottom:4px;">🚨 Erreurs</h3>
      <p style="margin-top:0;"><strong>${e.errors.total}</strong> erreur(s) totales</p>
      <ul style="margin-top:0;">${errorRows}</ul>` : ""}

      <hr style="margin: 24px 0;">
    `;
  }

  // HTML final du courriel
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: auto; color: #1a1a1a;">
      <h1 style="color: #0a6cb9;">🏊 Rapport hebdomadaire — Barracuda Coach IA</h1>
      <p><strong>Période :</strong> ${escapeHtml(report.period)}<br>
         <strong>Appels analysés en détail :</strong> ${escapeHtml(report.total_calls_analyzed)} (sur ${meta.total_fetched} appels totaux)<br>
         <strong>Coût analyse :</strong> ${meta.cost_usd ? "$" + meta.cost_usd.toFixed(4) : "N/A"} USD</p>

      ${metricsHtml}

      <h2>📝 Résumé global (Claude)</h2>
      <p>${escapeHtml(report.global_summary)}</p>

      ${report.top_issues?.length ? `<h2>🎯 Top problèmes à corriger</h2><ol>${issuesList}</ol>` : ""}

      ${synonymsList ? `<h2>🔤 Synonymes manquants</h2><ul>${synonymsList}</ul>` : ""}

      ${gapsList ? `<h2>📚 Lacunes de connaissance</h2><ul>${gapsList}</ul>` : ""}

      ${winsList ? `<h2>✅ Ce qui a bien fonctionné</h2><ul>${winsList}</ul>` : ""}

      <hr style="margin-top: 32px;">
      <p style="color: #888; font-size: 12px;">
        Rapport généré automatiquement à partir de ${meta.total_fetched} appels VAPI + events in-memory.<br>
        Tu peux appliquer manuellement les fixes proposés au prompt VAPI ou à <code>Ai.js</code>.<br>
        Pour relancer une analyse à tout moment : <code>POST /weekly-analysis?secret=...</code>
      </p>
    </div>`;
}

// --- ÉTAPE 5. Envoi du courriel via Resend ---
async function sendEmailReport(report, meta) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  if (!REPORT_EMAIL_TO) throw new Error("REPORT_EMAIL_TO missing");

  const html = reportToHtml(report, meta);
  const subject = `🏊 Coach IA — ${report.period} (${report.total_calls_analyzed} appels)`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: REPORT_EMAIL_FROM,
      to: [REPORT_EMAIL_TO],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend API HTTP ${response.status}: ${text}`);
  }

  return await response.json();
}

// --- ÉTAPE 6. Orchestration : la fonction qui enchaîne tout ---
// C'est cette fonction qui est appelée chaque dimanche (et par /weekly-analysis manuel)
async function runWeeklyAnalysis(days = 7) {
  // Période : les N derniers jours (défaut 7)
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(`[coach] Starting weekly analysis ${startDate.toISOString()} → ${endDate.toISOString()}`);

  // ① Fetch les appels VAPI de la semaine
  const allCalls = await fetchVapiCalls(startDate, endDate);
  console.log(`[coach] Fetched ${allCalls.length} calls`);

  // ② Snapshot des events SANS vider la liste (drain seulement après email envoyé OK)
  const eventsSnapshot = peekEvents();
  const callStats = computeCallStats(allCalls);
  const eventStats = computeEventStats(eventsSnapshot);
  const stats = { calls: callStats, events: eventStats };
  console.log(`[coach] Stats: ${callStats.total_calls} calls, ${eventsSnapshot.length} events captured`);

  // Objet « meta » qu'on passe à l'email
  const meta = {
    total_fetched: allCalls.length,
    cost_usd: 0,
    stats,
    period: `${startDate.toISOString().split("T")[0]} → ${endDate.toISOString().split("T")[0]}`,
  };

  // Si vraiment AUCUNE activité (ni appels, ni events), on saute
  if (allCalls.length === 0 && eventsSnapshot.length === 0) {
    console.log(`[coach] No calls and no events this period, skipping analysis.`);
    return { skipped: true, reason: "no_activity" };
  }

  // ③ Filtre les appels « intéressants »
  const interesting = allCalls.filter(isInterestingCall).map(compactCallForAnalysis);
  console.log(`[coach] ${interesting.length} interesting calls after pre-filtering`);

  let report;
  let cost_usd = 0;

  if (interesting.length === 0) {
    // Pas d'appel problématique → mini-rapport positif (mais on envoie quand même les métriques)
    report = {
      period: meta.period,
      total_calls_analyzed: 0,
      global_summary: allCalls.length > 0
        ? `Aucun appel problématique cette semaine sur ${allCalls.length} appels totaux. L'IA semble bien performer.`
        : `Aucun appel cette semaine. Activité SMS et recherches Shopify reportées ci-dessous.`,
      top_issues: [],
      missing_synonyms: [],
      knowledge_gaps: [],
      hallucinations_detected: [],
      wins: allCalls.length > 0 ? [`${allCalls.length} appels gérés sans signaux d'alerte`] : [],
    };
  } else {
    // ④ Analyse par Claude
    const result = await analyzeWithClaude(interesting, stats);
    report = result.report;
    cost_usd = result.cost_usd;
    console.log(`[coach] Claude analysis done. Cost: $${cost_usd?.toFixed(4)}`);
  }

  meta.cost_usd = cost_usd;

  // ⑤ Envoi du courriel
  await sendEmailReport(report, meta);
  console.log(`[coach] Email sent to ${REPORT_EMAIL_TO}`);

  // ⑥ Drain des events SEULEMENT APRÈS succès email
  // (si on draine avant et que l'email échoue, on perd les events de la semaine pour rien)
  const drained = drainEvents();
  console.log(`[coach] Drained ${drained.length} events after successful email`);

  return {
    sent: true,
    calls_fetched: allCalls.length,
    calls_analyzed: interesting.length,
    events_drained: drained.length,
    cost_usd,
    report,
  };
}

// --- ÉTAPE 7. Endpoint manuel + déclencheur cron interne ---

// Endpoint manuel : POST /weekly-analysis?secret=<ANALYSIS_SECRET>
// (Pratique pour tester sans attendre dimanche)
app.post("/weekly-analysis", async (req, res) => {
  const providedSecret = req.query.secret || req.body?.secret;
  if (providedSecret !== ANALYSIS_SECRET) {
    return res.status(401).json({ error: "Invalid secret" });
  }

  // Période paramétrable : ?days=N (défaut 7)
  const daysRaw = req.query.days || req.body?.days;
  const days = Math.max(1, Math.min(30, parseInt(daysRaw, 10) || 7));

  try {
    const result = await runWeeklyAnalysis(days);
    res.json({ ok: true, period_days: days, ...result });
  } catch (err) {
    console.error("[coach] FATAL:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cron interne : vérifie chaque heure si on est dimanche 23h Toronto.
// Si oui, et qu'on n'a pas déjà tourné aujourd'hui, on lance l'analyse.
// La fenêtre 23:00–23:59 couvre les éventuels redémarrages Railway pendant cette heure.
let lastWeeklyRunDate = null;
setInterval(async () => {
  try {
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: ANALYSIS_TIMEZONE }));
    const todayStr = local.toISOString().split("T")[0];

    // Dimanche = jour 0, à 23h, et pas déjà tourné aujourd'hui
    if (local.getDay() === 0 && local.getHours() === 23 && lastWeeklyRunDate !== todayStr) {
      lastWeeklyRunDate = todayStr;
      console.log(`[coach] CRON triggered at ${local.toISOString()} (local TZ ${ANALYSIS_TIMEZONE})`);
      const result = await runWeeklyAnalysis();
      console.log(`[coach] CRON done:`, JSON.stringify(result).slice(0, 200));
    }
  } catch (err) {
    console.error("[coach] CRON failed:", err);
  }
}, 60 * 60 * 1000); // toutes les 60 minutes


// ╭───────────────────────────────────────────────────────────────────────╮
// │  13bis. BOÎTE VOCALE — Voicemail Twilio quand le poste 104 ne répond pas │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// CONTEXTE :
//   Le numéro de transfert +1 819 617 1695 fait sonner le Yealink T53 (poste
//   SIP 104) directement via Twilio. Twilio N'A PAS de boîte vocale native.
//   On la fabrique donc ici : si le T53 ne répond pas dans le délai, Twilio
//   joue un message d'accueil, enregistre le message du client, puis on
//   l'envoie par courriel à info@piscinesbarracuda.com.
//
// CONFIG TWILIO REQUISE (dans le TwiML Bin du +18196171695) :
//   <Response>
//     <Dial timeout="20"
//           action="https://barracuda-ai-agent-production-806d.up.railway.app/voicemail/after-dial"
//           method="POST">
//       <Sip>sip:104@barracuda.sip.twilio.com</Sip>
//     </Dial>
//   </Response>
//   → timeout="20" = 20 s de sonnerie avant la bascule voicemail.
//   → action = appelé par Twilio à la FIN du Dial (répondu OU non).

// Helper : envoie le message vocal par courriel via le compte Resend info@.
// Pièce jointe .mp3 SI les creds Twilio sont présents, sinon lien d'écoute seul.
async function sendVoicemailEmail({ recordingUrl, durationSec, from, callSid }) {
  if (!RESEND_API_KEY_VOICEMAIL) throw new Error("RESEND_API_KEY_VOICEMAIL missing");

  const mp3Url = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;
  const mins = Math.floor(durationSec / 60);
  const secs = durationSec % 60;
  const durHuman = mins > 0 ? `${mins} min ${secs} s` : `${secs} s`;
  const nowHuman = new Date().toLocaleString("fr-CA", { timeZone: ANALYSIS_TIMEZONE });

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <h2 style="color:#0a6ebd">📞 Nouveau message vocal</h2>
      <p>
        <strong>De :</strong> ${escapeXml(from)}<br>
        <strong>Durée :</strong> ${escapeXml(durHuman)}<br>
        <strong>Reçu le :</strong> ${escapeXml(nowHuman)}
      </p>
      <p>
        <a href="${mp3Url}" style="display:inline-block;background:#0a6ebd;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
          ▶️ Écouter le message
        </a>
      </p>
      <p style="color:#888;font-size:12px;margin-top:24px">
        Barracuda Piscines &amp; Spas — message laissé sur la ligne lorsque personne n'a répondu au poste.
      </p>
    </div>`;

  // Pièce jointe optionnelle (nécessite les creds Twilio pour télécharger le média protégé)
  let attachments;
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    try {
      const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const audioResp = await fetch(mp3Url, { headers: { Authorization: `Basic ${auth}` } });
      if (audioResp.ok) {
        const buf = Buffer.from(await audioResp.arrayBuffer());
        attachments = [{
          filename: `message-vocal-${callSid || "barracuda"}.mp3`,
          content: buf.toString("base64"),
        }];
      } else {
        console.warn(`[voicemail] téléchargement audio HTTP ${audioResp.status} — courriel avec lien seulement`);
      }
    } catch (e) {
      console.warn("[voicemail] téléchargement audio échoué — courriel avec lien seulement:", e.message);
    }
  }

  const payload = {
    from: VOICEMAIL_EMAIL_FROM,
    to: [VOICEMAIL_EMAIL_TO],
    subject: `📞 Message vocal — ${from} (${durHuman})`,
    html,
  };
  if (attachments) payload.attachments = attachments;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY_VOICEMAIL}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend (voicemail) HTTP ${response.status}: ${text}`);
  }
  return await response.json();
}

// Anti-doublon : un même enregistrement peut déclencher À LA FOIS l'action
// (<Record action=...>) ET le recordingStatusCallback. On n'envoie qu'UN seul
// courriel par RecordingSid. En cas d'échec, on retire de la liste pour laisser
// l'autre callback réessayer.
const voicemailEmailed = new Set();

// Traite un enregistrement reçu de Twilio, depuis n'importe lequel des deux
// callbacks. `source` = "action" | "status-callback" (sert au diagnostic).
async function processVoicemailRecording(req, source) {
  const recordingUrl = req.body?.RecordingUrl;
  const durationSec = parseInt(req.body?.RecordingDuration, 10) || 0;
  const recordingStatus = req.body?.RecordingStatus || "";
  const from = req.query?.from || req.body?.From || "inconnu";
  const callSid = req.body?.CallSid || "";
  const recordingSid = req.body?.RecordingSid || callSid || "unknown";

  // DIAGNOSTIC : on logge CHAQUE appel de Twilio, avec ce qu'il nous envoie.
  // C'est ça qui nous dira lequel des deux callbacks Twilio déclenche réellement.
  logEvent("voicemail_callback_hit", {
    source,
    has_recording_url: !!recordingUrl,
    duration_sec: durationSec,
    recording_status: recordingStatus,
  });
  console.log(`[voicemail] HIT source=${source} url=${!!recordingUrl} dur=${durationSec}s status=${recordingStatus} from=${from}`);

  if (!recordingUrl) {
    console.warn(`[voicemail] ${source}: pas de RecordingUrl — ignoré`);
    return;
  }
  if (durationSec < 2) {
    console.log(`[voicemail] ${source}: message trop court (${durationSec}s) — ignoré`);
    logEvent("voicemail_skipped_short", { duration_sec: durationSec, source });
    return;
  }
  if (voicemailEmailed.has(recordingSid)) {
    console.log(`[voicemail] ${source}: déjà envoyé pour ${recordingSid} — doublon ignoré`);
    return;
  }
  voicemailEmailed.add(recordingSid);

  try {
    await sendVoicemailEmail({ recordingUrl, durationSec, from, callSid });
    console.log(`[voicemail] courriel envoyé à ${VOICEMAIL_EMAIL_TO} (source=${source}, ${durationSec}s, from ${from})`);
    logEvent("voicemail_emailed", { duration_sec: durationSec, source });
  } catch (err) {
    voicemailEmailed.delete(recordingSid);   // échec → l'autre callback pourra réessayer
    console.error(`[voicemail] ${source}: échec envoi courriel:`, err);
    logEvent("voicemail_error", { error: err.message, source });
  }
}

// ① Fallback : Twilio appelle cette route à la fin du <Dial> vers le poste 104.
app.post("/voicemail/after-dial", (req, res) => {
  const dialStatus = req.body?.DialCallStatus;            // completed | no-answer | busy | failed | canceled
  const from = req.body?.From || req.body?.Caller || "inconnu";
  res.set("Content-Type", "text/xml; charset=utf-8");

  // Quelqu'un a répondu (et l'appel est terminé) → rien à enregistrer.
  if (dialStatus === "completed") {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>`);
  }

  // Personne n'a répondu → on enregistre un message.
  console.log(`[voicemail] no-answer (status=${dialStatus}) from=${from} → enregistrement`);
  logEvent("voicemail_triggered", { dial_status: dialStatus });

  const cbUrl = `${PUBLIC_BASE_URL}/voicemail/recording-ready?from=${encodeURIComponent(from)}`;
  const doneUrl = `${PUBLIC_BASE_URL}/voicemail/recording-done?from=${encodeURIComponent(from)}`;

  return res.send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-CA" voice="Polly.Chantal">${escapeXml(VOICEMAIL_GREETING)}</Say>
  <Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" finishOnKey="#"
          action="${escapeXml(doneUrl)}" method="POST"
          recordingStatusCallback="${escapeXml(cbUrl)}" recordingStatusCallbackMethod="POST"
          recordingStatusCallbackEvent="completed"/>
  <Say language="fr-CA" voice="Polly.Chantal">Nous n'avons recu aucun message. Au revoir!</Say>
</Response>`
  );
});

// ② Action du <Record> : appelée si l'enregistrement se termine par # (finishOnKey),
//    par la limite de 120 s, ou par 5 s de silence. L'appel est encore actif ici,
//    donc on remercie le client À VOIX, PUIS on traite l'envoi (filet de sécurité).
app.post("/voicemail/recording-done", (req, res) => {
  res.set("Content-Type", "text/xml; charset=utf-8");
  res.send(
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-CA" voice="Polly.Chantal">Merci, votre message a bien ete enregistre. Au revoir!</Say>
  <Hangup/>
</Response>`
  );
  // Après avoir répondu à Twilio, on tente l'envoi (ne pas bloquer la réponse TwiML).
  processVoicemailRecording(req, "action").catch(e => console.error("[voicemail] action:", e));
});

// ③ recordingStatusCallback asynchrone : le chemin FIABLE quand le client RACCROCHE
//    (l'action ② n'est alors pas appelée). Twilio nous prévient que l'audio est prêt.
app.post("/voicemail/recording-ready", (req, res) => {
  res.status(204).end();   // on accuse réception immédiatement
  processVoicemailRecording(req, "status-callback").catch(e => console.error("[voicemail] status-callback:", e));
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  14. HEALTH CHECK & ENDPOINTS DE DIAGNOSTIC                            │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// GET / — page d'accueil du serveur, montre l'état de santé
// (utile pour vérifier que tout est bien configuré et que le serveur tourne)

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "VAPI ↔ Shopify bridge",
    routes: [
      "POST /search_shopify_products",
      "POST /search_shopify_orders",
      "POST /capture_lead",
      "POST /sms/incoming",
      "POST /voicemail/after-dial",
      "POST /voicemail/recording-done",
      "POST /voicemail/recording-ready",
      "POST /weekly-analysis",
      "GET /diagnose-shopify",
      "GET /diagnose-sms",
      "GET /events/stats",
    ],
    shopify_domain_configured: !!SHOPIFY_DOMAIN,
    shopify_token_configured: !!SHOPIFY_TOKEN,
    vapi_configured: !!(VAPI_PRIVATE_KEY && VAPI_ASSISTANT_ID),
    coach_configured: !!(ANTHROPIC_API_KEY && RESEND_API_KEY && REPORT_EMAIL_TO),
    voicemail_configured: !!RESEND_API_KEY_VOICEMAIL,
    voicemail_attachment_enabled: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN),
    assistants_map_loaded: Object.keys(VAPI_ASSISTANTS_MAP).length,   // 3 si bien configuré
    sms_sessions_active: smsSessions.size,
    events_buffered: EVENTS.length,
    api_version: SHOPIFY_API_VERSION,
  });
});

// GET /events/stats — voir les stats des events en temps réel
// (utile pour vérifier que les recherches sont bien loggées avant le rapport hebdo)
app.get("/events/stats", (_req, res) => {
  const events = peekEvents();
  res.json({
    ok: true,
    events_buffered: events.length,
    buffered_since: events[0]?.ts || null,
    stats: computeEventStats(events),
  });
});

// GET /diagnose-voicemail — diagnostic de la boîte vocale
//   • sans paramètre : montre la config + les derniers events voicemail_*
//   • ?send=1 : envoie un VRAI courriel test via Resend et retourne la
//     réponse exacte de Resend (HTTP + corps) → permet de voir POURQUOI
//     un envoi échoue (domaine non vérifié, destinataire non autorisé, etc.)
app.get("/diagnose-voicemail", async (req, res) => {
  const config = {
    voicemail_configured: !!RESEND_API_KEY_VOICEMAIL,
    attachment_enabled: !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN),
    email_to: VOICEMAIL_EMAIL_TO,
    email_from: VOICEMAIL_EMAIL_FROM,
    public_base_url: PUBLIC_BASE_URL,
  };

  // Derniers events liés à la voicemail (déclenchements, envois, erreurs)
  const recent_voicemail_events = peekEvents()
    .filter(e => typeof e.type === "string" && e.type.startsWith("voicemail"))
    .slice(-20);

  let send_test = null;
  if (req.query.send === "1") {
    // On appelle la VRAIE fonction d'envoi (celle qui plantait sur la timezone),
    // avec des données factices, pour valider tout le chemin sans avoir à rappeler.
    try {
      const result = await sendVoicemailEmail({
        recordingUrl: "https://example.com/diagnostic-test-aucun-audio",
        durationSec: 7,
        from: "TEST diagnostic",
        callSid: "diagnostic-test",
      });
      send_test = { ok: true, sent_via: "sendVoicemailEmail", resend_id: result?.id || null };
    } catch (e) {
      send_test = { ok: false, error: e.message };
    }
  }

  res.json({ config, recent_voicemail_events, send_test });
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  15. ROUTE — POST /search_shopify_orders                              │
// │       (Le tool que l'IA VAPI appelle pour chercher une commande)       │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// Le client donne son numéro de commande (avec ou sans le #),
// on cherche dans Shopify, on renvoie le statut + les items.
//
// ⚠️ PLAN SHOPIFY BASIC : on ne peut PAS accéder aux infos client
// (nom, email, téléphone, adresse). Cette query demande seulement
// les statuts + les items, qui sont autorisés.

// La requête GraphQL pour récupérer une commande
// ⚠️ On fetch maintenant aussi les `fulfillments` pour avoir tracking + ETA
//    - createdAt           : date d'expédition réelle
//    - estimatedDeliveryAt : ETA fournie par Shopify Shipping / carrier (peut être null)
//    - trackingInfo[]      : { company, number, url } — souvent 1 seul élément
const ORDER_GQL = `
  query GetOrder($q: String!) {
    orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 50) {
            edges {
              node {
                title
                quantity
                variantTitle
                sku
              }
            }
          }
          fulfillments(first: 5) {
            createdAt
            status
            estimatedDeliveryAt
            trackingInfo {
              company
              number
              url
            }
          }
        }
      }
    }
  }
`;

// Traduit le statut financier Shopify (en anglais MAJ) en libellé FR pour l'IA
const FINANCIAL_STATUS_FR = {
  PAID: "payée",
  PENDING: "en attente de paiement",
  AUTHORIZED: "autorisée",
  PARTIALLY_PAID: "partiellement payée",
  REFUNDED: "remboursée",
  PARTIALLY_REFUNDED: "partiellement remboursée",
  VOIDED: "annulée",
  EXPIRED: "expirée",
};

// Traduit le statut de livraison en FR
const FULFILLMENT_STATUS_FR = {
  FULFILLED: "expédiée",
  UNFULFILLED: "non expédiée",
  PARTIALLY_FULFILLED: "partiellement expédiée",
  RESTOCKED: "remise en stock",
  PENDING_FULFILLMENT: "en préparation",
  OPEN: "ouverte",
  IN_PROGRESS: "en cours",
  ON_HOLD: "en attente",
  SCHEDULED: "planifiée",
};

// ─── Estimation de livraison (ETA) ──────────────────────────────────────
//
// Stratégie :
//  1. Si Shopify fournit `estimatedDeliveryAt` → on l'utilise tel quel.
//  2. Sinon → estimation heuristique par carrier (jours OUVRABLES depuis l'expédition).
//
// Fourchettes calibrées pour livraisons au Québec depuis l'Outaouais.
// On retourne une plage (low/high) plutôt qu'une date unique pour rester honnête
// (l'IA pourra dire « entre le 2 et le 5 juin »).
const CARRIER_DELAYS_BUSINESS_DAYS = {
  CANADA_POST: { low: 4, high: 7 },   // mix Regular/Expedited, prudent
  UPS:         { low: 1, high: 4 },   // Standard Ground au QC
  PUROLATOR:   { low: 1, high: 3 },
  FEDEX:       { low: 2, high: 5 },
  DICOM:       { low: 1, high: 3 },
  DEFAULT:     { low: 3, high: 7 },
};

// Normalise le nom de la compagnie de livraison renvoyé par Shopify
// vers une clé interne (les marchands tapent souvent en libre).
function normalizeCarrier(companyRaw) {
  const c = String(companyRaw || "").toLowerCase().trim();
  if (!c) return "DEFAULT";
  if (c.includes("canada post") || c.includes("postes canada") || c === "canadapost") return "CANADA_POST";
  if (c.includes("ups") || c.includes("united parcel")) return "UPS";
  if (c.includes("purolator")) return "PUROLATOR";
  if (c.includes("fedex")) return "FEDEX";
  if (c.includes("dicom") || c.includes("gls")) return "DICOM";
  return "DEFAULT";
}

// Affichage lisible du carrier pour l'IA (français)
const CARRIER_LABEL_FR = {
  CANADA_POST: "Postes Canada",
  UPS: "UPS",
  PUROLATOR: "Purolator",
  FEDEX: "FedEx",
  DICOM: "Dicom",
  DEFAULT: "le transporteur",
};

// Ajoute N jours ouvrables (skip samedi/dimanche) à une date
function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 0 = dim, 6 = sam
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

// Formate une date pour lecture vocale + SMS : « 26 mai deux mille vingt-six »
//
// Pourquoi l'année en lettres : le TTS multilingue (Cartesia / ElevenLabs avec
// voix québécoise) lit souvent les nombres à 4 chiffres en anglais
// (« 2026 » → « twenty twenty-six »). Forcer l'année en lettres françaises
// garantit la prononciation FR. Le jour reste en chiffres (« 26 » est lu
// « vingt-six » correctement).
const YEAR_FR = {
  2024: "deux mille vingt-quatre",
  2025: "deux mille vingt-cinq",
  2026: "deux mille vingt-six",
  2027: "deux mille vingt-sept",
  2028: "deux mille vingt-huit",
  2029: "deux mille vingt-neuf",
  2030: "deux mille trente",
};

function formatDate(date) {
  // Composantes en timezone Toronto pour éviter dérive UTC
  const parts = new Date(date).toLocaleDateString("fr-CA", {
    timeZone: "America/Toronto",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).split(" ");
  // fr-CA → ["26", "mai", "2026"]
  const [day, month, yearStr] = parts;
  const year = parseInt(yearStr, 10);
  const yearWords = YEAR_FR[year] || yearStr; // fallback : chiffres si année hors table
  return `${day} ${month} ${yearWords}`;
}

// Calcule l'ETA pour un fulfillment Shopify.
// Retourne { eta_low, eta_high, eta_human_fr, source } ou null si rien d'utile.
function computeEta(fulfillment) {
  if (!fulfillment) return null;

  // Cas 1 : Shopify connaît déjà l'ETA exacte → on l'utilise
  if (fulfillment.estimatedDeliveryAt) {
    const eta = new Date(fulfillment.estimatedDeliveryAt);
    return {
      eta_low: eta.toISOString(),
      eta_high: eta.toISOString(),
      eta_human_fr: `arrivée prévue le ${formatDate(eta)}`,
      source: "shopify",
    };
  }

  // Cas 2 : on calcule depuis carrier + date d'expédition
  if (!fulfillment.createdAt) return null;
  const shippedAt = new Date(fulfillment.createdAt);
  const carrier = normalizeCarrier(fulfillment.trackingInfo?.[0]?.company);
  const delay = CARRIER_DELAYS_BUSINESS_DAYS[carrier] || CARRIER_DELAYS_BUSINESS_DAYS.DEFAULT;

  const etaLow = addBusinessDays(shippedAt, delay.low);
  const etaHigh = addBusinessDays(shippedAt, delay.high);
  const carrierLabel = CARRIER_LABEL_FR[carrier];

  return {
    eta_low: etaLow.toISOString(),
    eta_high: etaHigh.toISOString(),
    eta_human_fr: `arrivée prévue entre ${formatDate(etaLow)} et ${formatDate(etaHigh)} via ${carrierLabel}`,
    source: "estimated",
  };
}

// Formate une commande pour l'IA : statuts traduits + items lisibles
function formatOrder(o) {
  const items = (o.lineItems?.edges || []).map(e => ({
    title: e.node.title,
    quantity: e.node.quantity,
    variant: e.node.variantTitle || null,
    sku: e.node.sku || null,
  }));

  const financial = o.displayFinancialStatus || "UNKNOWN";
  const fulfillment = o.displayFulfillmentStatus || "UNKNOWN";

  // On prend le fulfillment le plus récent (la commande peut en avoir plusieurs
  // si elle a été expédiée en plusieurs colis). Le plus pertinent = le dernier.
  const fulfillments = (o.fulfillments || []).filter(f => f.status === "SUCCESS" || f.status === "OPEN" || !f.status);
  const lastFulfillment = fulfillments[fulfillments.length - 1] || null;
  const tracking = lastFulfillment?.trackingInfo?.[0] || null;
  const eta = computeEta(lastFulfillment);

  return {
    order_number: o.name,
    created_at: o.createdAt,
    financial_status: financial,
    financial_status_fr: FINANCIAL_STATUS_FR[financial] || financial.toLowerCase(),
    fulfillment_status: fulfillment,
    fulfillment_status_fr: FULFILLMENT_STATUS_FR[fulfillment] || fulfillment.toLowerCase(),
    total: parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
    currency: o.totalPriceSet?.shopMoney?.currencyCode || "CAD",
    items,
    items_count: items.length,
    // Infos d'expédition (null si non expédiée ou pas de tracking enregistré)
    shipped_at: lastFulfillment?.createdAt || null,
    tracking_number: tracking?.number || null,
    tracking_url: tracking?.url || null,
    carrier: tracking?.company || null,
    eta_low: eta?.eta_low || null,
    eta_high: eta?.eta_high || null,
    eta_human_fr: eta?.eta_human_fr || null,
    eta_source: eta?.source || null,
  };
}

// Endpoint POST /search_shopify_orders
app.post("/search_shopify_orders", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);
  const start = Date.now();

  try {
    // L'IA peut envoyer le numéro sous différents noms de champ — on accepte tout
    const raw = String(
      args.order_number ?? args.order_id ?? args.number ??
      args.query ?? args.q ?? args.order ?? ""
    ).trim();

    if (!raw) {
      return res.json(vapiResult(toolCallId, {
        found: false,
        count: 0,
        orders: [],
        message: "Aucun numéro de commande fourni. Demande au client son numéro de commande.",
      }));
    }

    // Nettoyage : retire le # initial et les espaces
    const cleaned = raw.replace(/^#+/, "").replace(/\s+/g, "");
    if (!cleaned) {
      return res.json(vapiResult(toolCallId, {
        found: false,
        count: 0,
        orders: [],
        original_input: raw,
        message: "Numéro de commande invalide. Demande au client de répéter clairement.",
      }));
    }

    // Construit la requête Shopify (on remet le # devant pour le format Shopify)
    const shopifyQuery = `name:#${cleaned}`;

    const data = await fetchShopifyGraphQL(ORDER_GQL, { q: shopifyQuery });
    const orders = (data.orders?.edges || []).map(e => formatOrder(e.node));
    const ms = Date.now() - start;

    console.log(`[search_shopify_orders] input="${raw}" query="${shopifyQuery}" found=${orders.length} ms=${ms}ms`);

    // Log événement pour les stats du coach hebdo
    logEvent("shopify_order_search", {
      order_number: cleaned,
      found: orders.length > 0,
      count: orders.length,
      ms,
    });

    // Aucune commande trouvée
    if (orders.length === 0) {
      return res.json(vapiResult(toolCallId, {
        found: false,
        count: 0,
        orders: [],
        original_input: raw,
        normalized_query: shopifyQuery,
        message: `Aucune commande trouvée avec le numéro #${cleaned}. Demande au client de vérifier son numéro (il se trouve dans le courriel de confirmation).`,
      }));
    }

    // Commande trouvée → on construit un résumé lisible pour l'IA
    const main = orders[0];

    // Bout de phrase sur l'expédition + ETA si la commande a été shippée.
    // On NE met PAS le tracking_number dans le résumé texte : il est trop long
    // pour être dicté en voix. L'IA va le récupérer depuis le JSON (champs
    // `tracking_number` + `tracking_url`) et l'utiliser SEULEMENT en SMS.
    let shippingPart = "";
    if (main.shipped_at) {
      shippingPart = ` Expédiée le ${formatDate(main.shipped_at)}`;
      if (main.eta_human_fr) shippingPart += `, ${main.eta_human_fr}`;
      if (main.tracking_number) shippingPart += `. Suivi disponible`;
      shippingPart += ".";
    }

    const summary = `Commande ${main.order_number} du ${formatDate(main.created_at)} : ${main.financial_status_fr}, ${main.fulfillment_status_fr}. ${main.items_count} article(s) : ${main.items.map(i => `${i.quantity}× ${i.title}`).join(", ")}.${shippingPart}`;

    return res.json(vapiResult(toolCallId, {
      found: true,
      count: orders.length,
      orders,
      original_input: raw,
      normalized_query: shopifyQuery,
      message: orders.length === 1
        ? summary
        : `${orders.length} commandes correspondent. La plus récente : ${summary}`,
    }));
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[search_shopify_orders] ERROR after ${ms}ms:`, err);
    logEvent("error", { where: "search_shopify_orders", message: err.message, ms });
    return res.json(vapiResult(toolCallId, {
      found: false,
      count: 0,
      orders: [],
      error: err.message,
      message: "Erreur technique lors de la recherche de la commande. Excuse-toi auprès du client et propose de réessayer.",
    }));
  }
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  16. DIAGNOSTIC SHOPIFY                                               │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// GET /diagnose-shopify — visite l'URL dans un navigateur pour vérifier :
//   • que la connexion à Shopify fonctionne
//   • que le token a les bonnes permissions
//   • voir 3 produits exemples du catalogue
// (Pratique quand on suspecte un problème côté Shopify)

app.get("/diagnose-shopify", async (_req, res) => {
  try {
    const data = await fetchShopifyGraphQL(`
      query Diagnose {
        shop {
          name
          primaryDomain { host }
          plan { displayName }
        }
        products(first: 3) {
          edges {
            node {
              id
              title
              status
              vendor
              productType
              totalInventory
              tags
            }
          }
        }
      }
    `);
    res.json({
      ok: true,
      shop: data.shop,
      sample_products: (data.products?.edges || []).map(e => e.node),
      product_count_sample: data.products?.edges?.length || 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ╭───────────────────────────────────────────────────────────────────────╮
// │  17. DÉMARRAGE DU SERVEUR                                             │
// ╰───────────────────────────────────────────────────────────────────────╯
//
// C'est la dernière étape : on dit à Express d'écouter sur le port.
// Quand tu vois « [BOOT] Server listening on port X » dans les logs Railway,
// ça veut dire que tout est prêt à recevoir des requêtes.

app.listen(PORT, () => {
  console.log(`[BOOT] Server listening on port ${PORT}`);
  console.log(`[BOOT] Shopify domain: ${SHOPIFY_DOMAIN || "(missing)"}`);
  console.log(`[BOOT] Shopify API version: ${SHOPIFY_API_VERSION}`);
});
