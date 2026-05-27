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
app.use(express.json());                          // Comprend les requêtes en JSON
app.use(express.urlencoded({ extended: true })); // Comprend les requêtes en formulaire (Twilio)


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
const ANALYSIS_TIMEZONE = process.env.ANALYSIS_TIMEZONE || "America/Toronto"; // fuseau horaire pour le cron du dimanche

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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,   // notre clé d'accès Shopify
    },
    body: JSON.stringify({ query, variables }),
  });

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
  "alcalinite":  ["alkalinity", "alc", "ta"],
  "durete":      ["calcium", "hardness", "ch", "durete calcique"],
  "stabilisant": ["stabilizer", "acide cyanurique", "cya", "cyanuric"],
  "algicide":    ["algaecide", "algecide", "anti algues", "anti-algues"],
  "floculant":   ["flocculant", "clarifiant", "clarifier"],
  "sel":         ["salt", "saline", "electrolyse", "electrolyseur", "salt cell"],
  "oxygene":     ["oxygen", "peroxyde", "shock"],
  "choc":        ["shock", "superchloration", "super chlore"],

  // --- Équipement ---
  "pompe":       ["pump", "circulateur", "moteur"],
  "filtre":      ["filter", "filtration", "filtreur"],
  "cartouche":   ["cartridge", "element filtrant"],
  "sable":       ["sand", "sable filtrant"],
  "verre":       ["glass media", "verre filtrant"],
  "chauffage":   ["heater", "rechauffeur", "thermopompe", "heat pump", "chauffe eau"],
  "echangeur":   ["exchanger", "heat exchanger"],
  "minuterie":   ["timer", "horloge", "controle"],
  "ecumoir":     ["skimmer", "ecumeur"],
  "buse":        ["jet", "return", "refoulement", "eyeball"],
  "valve":       ["vanne", "valve multivoie", "multivoies", "multiport"],
  "tuyau":       ["hose", "boyau", "pipe", "conduite"],
  "raccord":     ["fitting", "union", "coude", "te", "elbow"],
  "drain":       ["drain de fond", "main drain", "bonde"],

  // --- Liner / structure / type de piscine ---
  "toile":       ["liner", "toile vinyle", "vinyl liner", "membrane"],
  "vinyle":      ["vinyl", "pvc"],
  "fibre":       ["fiberglass", "fibre de verre", "fiberglass pool"],
  "beton":       ["concrete", "gunite"],
  "creusee":     ["inground", "in ground", "enterree", "enterre"],
  "horsterre":   ["hors terre", "above ground", "aboveground", "ht"],
  "semi":        ["semi creusee", "semi enterree", "semi inground"],

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

  // --- Tests d'eau ---
  "bandelette":  ["bandelettes", "strip", "strips", "test strip", "bandes test"],
  "analyse":     ["analysis", "test eau", "water analysis", "water test"],
  "trousse":     ["kit", "test kit", "trousse danalyse"],
  "reactif":     ["reagent", "reactifs", "reagents"],

  // --- Spa ---
  "spa":         ["hot tub", "jacuzzi", "tourbillon"],
  "filtre spa":  ["spa filter", "filtre jacuzzi"],

  // --- Piscine générique ---
  "piscine":     ["pool", "swimming pool", "bassin"],

  // --- Couverture / hivernage ---
  "couverture":  ["cover", "bache", "toile dhiver", "winter cover"],
  "solaire":     ["solar cover", "couverture solaire", "bache solaire", "bulle"],
  "hivernage":   ["winter", "winterizing", "wintering", "fermeture"],
  "ouverture":   ["opening", "demarrage"],

  // --- Nettoyage ---
  "robot":       ["robotic cleaner", "aspirateur robot", "cleaner", "polaris", "dolphin"],
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
    if (inStockOnly) parts.push(`inventory_total:>0`);
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

function formatProduct(p) {
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
    price_min: parseFloat(p.priceRangeV2?.minVariantPrice?.amount ?? "0"),
    price_max: parseFloat(p.priceRangeV2?.maxVariantPrice?.amount ?? "0"),
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode || "CAD",
    variants: (p.variants?.edges || []).map(v => ({
      id: v.node.id,
      title: v.node.title,
      sku: v.node.sku,
      price: parseFloat(v.node.price),
      stock: v.node.inventoryQuantity,
      available: v.node.availableForSale,
    })),
  };
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
    const formatted = products.map(formatProduct);
    const ms = Date.now() - start;

    console.log(`[search_shopify_products] level=${level} count=${formatted.length} ms=${ms}ms query="${finalQuery}"`);

    // Enregistre l'événement pour les stats du coach hebdo
    logEvent("shopify_product_search", {
      query: args.query || "",
      results_count: formatted.length,
      cascade_level: level,
      widened,
      ms,
    });

    // Réponse à l'IA
    const response = {
      count: formatted.length,
      products: formatted,
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
      message: buildMessage({ count: formatted.length, level, widened }),
    };

    // Si 0 résultat, on inclut la trace de toutes les tentatives pour pouvoir débuger
    if (formatted.length === 0) {
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

  const finalInput = channelHint + message;
  console.log(`[vapiChat] channel=${channel} previousChatId=${previousChatId || "NONE"} input="${finalInput.slice(0, 120)}..."`);

  const body = {
    assistantId: VAPI_ASSISTANT_ID,
    input: finalInput,
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
async function runWeeklyAnalysis() {
  // Période : les 7 derniers jours
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

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

  try {
    const result = await runWeeklyAnalysis();
    res.json({ ok: true, ...result });
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
      "POST /sms/incoming",
      "POST /weekly-analysis",
      "GET /diagnose-shopify",
      "GET /diagnose-sms",
      "GET /events/stats",
    ],
    shopify_domain_configured: !!SHOPIFY_DOMAIN,
    shopify_token_configured: !!SHOPIFY_TOKEN,
    vapi_configured: !!(VAPI_PRIVATE_KEY && VAPI_ASSISTANT_ID),
    coach_configured: !!(ANTHROPIC_API_KEY && RESEND_API_KEY && REPORT_EMAIL_TO),
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

// Formate une date pour lecture vocale + SMS : « 26 mai 2026 »
// Pourquoi pas ISO YYYY-MM-DD : le TTS le lit « deux mille vingt-six tiret zéro
// cinq tiret vingt-six » — imprononçable. Le format « 26 mai 2026 » est lu
// « vingt-six mai deux mille vingt-six », naturel en français parlé.
function formatDate(date) {
  return new Date(date).toLocaleDateString("fr-CA", {
    timeZone: "America/Toronto",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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
