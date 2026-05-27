// ============================================================
// Ai.js — VAPI ↔ Shopify bridge (Railway, Node ES Modules)
// Route principale : POST /search_shopify_products
// ============================================================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ============================================================
// ENV
// ============================================================

const PORT = process.env.PORT || 8080;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

// SMS (Twilio webhook → VAPI Chat → Twilio reply)
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

// Analyse hebdo des appels VAPI (« coach IA »)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REPORT_EMAIL_TO = process.env.REPORT_EMAIL_TO;
const REPORT_EMAIL_FROM = process.env.REPORT_EMAIL_FROM || "Barracuda Coach <onboarding@resend.dev>";
const ANALYSIS_SECRET = process.env.ANALYSIS_SECRET || "change-me";
const ANALYSIS_TIMEZONE = process.env.ANALYSIS_TIMEZONE || "America/Toronto";

// Mapping UUID assistant VAPI → nom lisible. JSON dans env var.
// Ex: VAPI_ASSISTANTS_MAP='{"7f9e...":"Accueil","dad1...":"FR","3f65...":"EN"}'
let VAPI_ASSISTANTS_MAP = {};
try {
  VAPI_ASSISTANTS_MAP = process.env.VAPI_ASSISTANTS_MAP
    ? JSON.parse(process.env.VAPI_ASSISTANTS_MAP)
    : {};
} catch (err) {
  console.warn("[BOOT] VAPI_ASSISTANTS_MAP invalide (JSON malformé) — split par assistant désactivé:", err.message);
  VAPI_ASSISTANTS_MAP = {};
}

if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
  console.warn("[BOOT] WARNING: SHOPIFY_DOMAIN or SHOPIFY_TOKEN missing — Shopify calls will fail.");
}
if (!VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
  console.warn("[BOOT] WARNING: VAPI_PRIVATE_KEY or VAPI_ASSISTANT_ID missing — SMS will fail.");
}
if (!ANTHROPIC_API_KEY || !RESEND_API_KEY || !REPORT_EMAIL_TO) {
  console.warn("[BOOT] WARNING: ANTHROPIC_API_KEY / RESEND_API_KEY / REPORT_EMAIL_TO missing — weekly analysis will fail.");
}


// ============================================================
// EVENT LOGGING — in-memory, drainé par le coach hebdo dans l'email
// Volatile : un redémarrage Railway = events perdus. Acceptable pour
// le volume actuel (~20 calls/jour) et le coach hebdo.
// ============================================================

const EVENTS = [];
const EVENTS_MAX = 10_000;

function logEvent(type, meta = {}) {
  EVENTS.push({ ts: new Date().toISOString(), type, ...meta });
  if (EVENTS.length > EVENTS_MAX) {
    EVENTS.splice(0, EVENTS.length - EVENTS_MAX); // FIFO drop
  }
}

function drainEvents() {
  const snapshot = EVENTS.slice();
  EVENTS.length = 0;
  return snapshot;
}

function peekEvents() {
  return EVENTS.slice();
}

// Hash sha256 tronqué — assez pour grouper sessions sans stocker PII en clair
function hashPhone(phone) {
  return crypto.createHash("sha256").update(String(phone || "")).digest("hex").slice(0, 12);
}


// ============================================================
// HELPER — Shopify Admin GraphQL
// ============================================================

async function fetchShopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${text}`);
  }

  const json = await response.json();

  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}


// ============================================================
// HELPER — VAPI tool call extraction
// ============================================================

function getVapiToolCall(req) {
  const toolCall = req.body?.message?.toolCalls?.[0];
  let args = toolCall?.function?.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return { toolCall, toolCallId: toolCall?.id ?? null, args: args || {} };
}

function vapiResult(toolCallId, result) {
  return { results: [{ toolCallId, result }] };
}


// ============================================================
// NORMALISATION & TOKENISATION
// ============================================================

function normalize(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // retire accents
    .replace(/[^\w\s-]/g, " ")          // retire ponctuation (garde tiret)
    .replace(/\s+/g, " ")
    .trim();
}

// Mots vides FR/EN — retirés avant la recherche
const STOPWORDS = new Set([
  "le","la","les","l","de","des","du","d","un","une","et","ou","a","au","aux",
  "pour","avec","sans","sur","sous","dans","par","ce","cette","ces","mon","ma",
  "mes","ton","ta","tes","son","sa","ses","est","sont","je","tu","il","elle",
  "on","nous","vous","ils","elles","qui","que","quoi","dont","ne","pas","plus",
  "the","of","and","or","for","with","without","on","in","by","this","that",
  "is","are","be","to","at","from","as","an"
]);

function tokenize(s) {
  return normalize(s)
    .split(" ")
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}


// ============================================================
// DICTIONNAIRE SYNONYMES (FR ↔ EN ↔ jargon piscine/spa)
// Ajoute/édite ici sans rien d'autre à toucher.
// ============================================================

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

// Index inverse : pour un token donné, retourne tous ses équivalents (incluant lui-même)
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

function expandSynonyms(token) {
  const n = normalize(token);
  const set = SYNONYM_LOOKUP.get(n);
  return set ? [...set] : [n];
}


// ============================================================
// CONSTRUCTEUR DE REQUÊTE SHOPIFY SEARCH SYNTAX
// ============================================================

// Échappe les guillemets dans une valeur de recherche Shopify
function esc(v) {
  return String(v).replace(/"/g, '\\"');
}

// Shopify search syntax supporte les wildcards en SUFFIXE seulement (`mot*`).
// Les wildcards englobants (`*mot*`) ne fonctionnent pas → retournent 0 silencieusement.
function buildShopifyQuery({ tokens, vendor, productType, tags, inStockOnly, level }) {
  const parts = [];

  if (tokens && tokens.length > 0) {
    if (level === "STRICT") {
      // Chaque token doit apparaître exactement (match de token, pas de wildcard)
      const block = tokens.map(tok => `title:${tok}`).join(" AND ");
      parts.push(block);
    } else if (level === "TOKENS") {
      // Préfixe sur chaque token, dans title/tag/product_type
      const block = tokens
        .map(tok => `(title:${tok}* OR tag:${tok}* OR product_type:${tok}*)`)
        .join(" AND ");
      parts.push(block);
    } else if (level === "SYNONYMES") {
      // Tokens + synonymes (OR par token, AND entre tokens), préfixe
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        const ors = syns
          .map(s => `title:${s}* OR tag:${s}* OR product_type:${s}* OR vendor:${s}*`)
          .join(" OR ");
        return `(${ors})`;
      }).join(" AND ");
      parts.push(block);
    } else if (level === "FILTERS_OFF") {
      // Synonymes mais on drop vendor/type/tags pour élargir
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        const ors = syns.map(s => `title:${s}* OR tag:${s}*`).join(" OR ");
        return `(${ors})`;
      }).join(" AND ");
      parts.push(block);
    } else if (level === "KEYWORD") {
      // Token le plus long + ses synonymes
      const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
      const syns = expandSynonyms(longest);
      const ors = syns.map(s => `title:${s}* OR tag:${s}*`).join(" OR ");
      parts.push(`(${ors})`);
    } else if (level === "TAGS_ONLY") {
      // Tags seulement
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        return `(${syns.map(s => `tag:${s}*`).join(" OR ")})`;
      }).join(" OR ");
      parts.push(block);
    } else if (level === "FULLTEXT") {
      // Dernier recours : full-text tokenisé par défaut de Shopify (aucun champ explicite)
      parts.push(tokens.join(" "));
    }
  }

  // Filtres structurels + stock : uniquement aux niveaux stricts.
  // À partir de FILTERS_OFF on drop TOUT (y compris inStockOnly) pour maximiser le rappel.
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

  // Toujours exclure drafts/archivés
  parts.push(`status:active`);

  return parts.join(" AND ");
}


// ============================================================
// REQUÊTE GRAPHQL PRODUITS
// ============================================================

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


// ============================================================
// RECHERCHE EN CASCADE — du plus précis au plus large
// ============================================================

const CASCADE_LEVELS = ["STRICT", "TOKENS", "SYNONYMES", "FILTERS_OFF", "KEYWORD", "TAGS_ONLY", "FULLTEXT"];

function applyPriceFilter(products, minPrice, maxPrice) {
  if (minPrice == null && maxPrice == null) return products;
  return products.filter(p => {
    const min = parseFloat(p.priceRangeV2?.minVariantPrice?.amount ?? "0");
    const max = parseFloat(p.priceRangeV2?.maxVariantPrice?.amount ?? "0");
    if (minPrice != null && max < minPrice) return false;       // tout l'éventail sous min
    if (maxPrice != null && min > maxPrice) return false;       // tout l'éventail au-dessus de max
    return true;
  });
}

async function runShopifySearch(qStr, fetchCount) {
  const data = await fetchShopifyGraphQL(PRODUCTS_GQL, { q: qStr, first: fetchCount });
  return (data.products?.edges || []).map(e => e.node);
}

async function cascadeSearch(args) {
  const {
    query, vendor, productType, tags,
    minPrice, maxPrice, inStockOnly,
    limit, widenIfEmpty,
  } = args;

  const tokens = tokenize(query);
  const fetchCount = Math.min(Math.max(limit * 2, 10), 100); // marge pour filtrage prix client-side
  const debugTrace = [];

  // Cas 1 : pas de texte, seulement des filtres
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

  // Cas 2 : cascade textuelle
  const levels = widenIfEmpty ? CASCADE_LEVELS : CASCADE_LEVELS.slice(0, 3);

  for (const level of levels) {
    const q = buildShopifyQuery({ tokens, vendor, productType, tags, inStockOnly, level });
    let products;
    try {
      products = await runShopifySearch(q, fetchCount);
    } catch (err) {
      console.error(`[cascade] level=${level} FAILED query="${q}" err=${err.message}`);
      debugTrace.push({ level, query: q, error: err.message });
      continue; // on tente le niveau suivant
    }

    const before = products.length;
    products = applyPriceFilter(products, minPrice, maxPrice);
    debugTrace.push({ level, query: q, fetched: before, after_price_filter: products.length });
    console.log(`[cascade] level=${level} query="${q}" fetched=${before} after_price_filter=${products.length}`);

    if (products.length > 0) {
      return {
        products: products.slice(0, limit),
        level,
        finalQuery: q,
        widened: level !== "STRICT",
        debugTrace,
      };
    }
  }

  return { products: [], level: "NONE", finalQuery: null, widened: true, debugTrace };
}


// ============================================================
// FORMATAGE RÉSULTATS POUR L'IA VAPI
// ============================================================

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

function buildMessage({ count, level, widened }) {
  if (count === 0) {
    return "Aucun produit trouvé même après élargissement progressif. Demande au client de reformuler ou propose-lui des catégories générales (chimie, filtration, accessoires).";
  }
  if (!widened) {
    return `${count} produit(s) trouvé(s) avec les critères exacts demandés.`;
  }
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


// ============================================================
// ROUTE — POST /search_shopify_products  (tool VAPI)
// ============================================================

app.post("/search_shopify_products", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);
  const start = Date.now();

  try {
    // Validation : au moins un critère
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

    // Normalisation des arguments
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
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
      widenIfEmpty: args.widen_if_empty !== false,
    };

    const { products, level, finalQuery, widened, debugTrace } = await cascadeSearch(searchArgs);
    const formatted = products.map(formatProduct);
    const ms = Date.now() - start;

    console.log(`[search_shopify_products] level=${level} count=${formatted.length} ms=${ms}ms query="${finalQuery}"`);

    logEvent("shopify_product_search", {
      query: args.query || "",
      results_count: formatted.length,
      cascade_level: level,
      widened,
      ms,
    });

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

    // Diagnostic : si 0 résultat, on remonte la trace pour comprendre sans aller dans Railway
    if (formatted.length === 0) {
      response.debug = debugTrace;
    }

    return res.json(vapiResult(toolCallId, response));
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[search_shopify_products] ERROR after ${ms}ms:`, err);
    logEvent("error", { where: "search_shopify_products", message: err.message, ms });
    // VAPI: on renvoie 200 avec error dans result pour que l'IA puisse l'expliquer au client
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


// ============================================================
// SMS — Pont Twilio ↔ VAPI Chat
// Twilio reçoit le SMS → webhook POST /sms/incoming → VAPI Chat API
// → réponse renvoyée en TwiML, Twilio envoie le SMS au client.
//
// Setup côté Twilio : Phone Numbers → ton numéro → Messaging →
//   "A message comes in" → Webhook → URL = .../sms/incoming (POST)
//
// Env requis : VAPI_PRIVATE_KEY (Bearer token API VAPI),
//              VAPI_ASSISTANT_ID (l'assistant à utiliser pour le SMS)
// ============================================================

const SMS_SESSION_TTL_MS = 60 * 60 * 1000; // 1h — sessions plus vieilles = abandonnées
const smsSessions = new Map(); // phoneNumber → { previousChatId, lastSeen }

function getSmsSession(phone) {
  const s = smsSessions.get(phone);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SMS_SESSION_TTL_MS) {
    smsSessions.delete(phone);
    return null;
  }
  return s;
}

function setSmsSession(phone, chatId) {
  smsSessions.set(phone, { previousChatId: chatId, lastSeen: Date.now() });
}

// Échappe le contenu utilisateur pour insertion sûre dans le XML TwiML
function escapeXml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Appelle l'API VAPI Chat avec continuité de conversation via previousChatId
async function vapiChat(message, previousChatId = null) {
  if (!VAPI_PRIVATE_KEY || !VAPI_ASSISTANT_ID) {
    throw new Error("VAPI credentials missing (VAPI_PRIVATE_KEY / VAPI_ASSISTANT_ID)");
  }

  const body = { assistantId: VAPI_ASSISTANT_ID, input: message };
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

  // VAPI Chat peut renvoyer plusieurs messages (firstMessage + réponse réelle).
  // On veut TOUJOURS le DERNIER message assistant — sinon on récupère la salutation
  // au lieu de la réponse à la question du user.
  let reply = "";

  if (Array.isArray(data.output) && data.output.length > 0) {
    const assistantMsgs = data.output.filter(m => m?.role === "assistant");
    reply = assistantMsgs[assistantMsgs.length - 1]?.content || "";
  }

  if (!reply && Array.isArray(data.messages) && data.messages.length > 0) {
    const assistantMsgs = data.messages.filter(m => m?.role === "assistant");
    reply = assistantMsgs[assistantMsgs.length - 1]?.content || "";
  }

  if (!reply) {
    reply = data.message || data.content || "";
  }

  return { chatId: data.id, reply, raw: data };
}

// Endpoint webhook Twilio (form-urlencoded)
app.post("/sms/incoming", async (req, res) => {
  const from = req.body?.From;
  const to = req.body?.To;
  const body = req.body?.Body;
  const sid = req.body?.MessageSid;
  const smsStart = Date.now();
  const phoneHash = hashPhone(from);

  console.log(`[sms] incoming from=${from} to=${to} sid=${sid} body="${body}"`);

  // Twilio attend du TwiML quelle que soit l'issue
  res.set("Content-Type", "text/xml; charset=utf-8");

  if (!from || !body || !body.trim()) {
    // Pas de contenu → on accuse simplement réception (réponse vide)
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }

  try {
    const session = getSmsSession(from);
    console.log(`[sms] session_lookup phone=${from} previous_chat_id=${session?.previousChatId || "NONE (new conversation)"}`);

    logEvent("sms_received", {
      phone_hash: phoneHash,
      body_len: body.length,
      is_new_session: !session,
    });

    const { chatId, reply } = await vapiChat(body.trim(), session?.previousChatId);
    if (chatId) setSmsSession(from, chatId);

    const finalReply = (reply && reply.trim())
      || "Désolé, je n'ai pas saisi votre message. Pouvez-vous reformuler? / Sorry, I didn't catch that. Could you rephrase?";

    console.log(`[sms] reply to ${from} new_chatId=${chatId} reply="${finalReply.slice(0, 100)}..."`);

    logEvent("sms_replied", {
      phone_hash: phoneHash,
      latency_ms: Date.now() - smsStart,
      reply_len: finalReply.length,
    });

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
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escapeXml(
        "Désolé, erreur technique. Réessayez dans un instant ou appelez-nous au magasin."
      )}</Message></Response>`
    );
  }
});

// Diagnostic SMS — hit depuis le navigateur pour vérifier que VAPI Chat répond
// Accepte ?msg=... pour tester un message custom
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
      raw_response: raw, // structure complète pour debug
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ============================================================
// COACH IA — Analyse hebdo des appels VAPI
// 1. Fetch les appels VAPI de la semaine
// 2. Pré-filtre les « intéressants » (échecs, courts, erreurs)
// 3. Envoie à Claude Sonnet 4.6 qui produit un rapport JSON
// 4. Envoie le rapport par courriel via Resend
//
// Déclencheur : automatique tous les dimanches 23h (timezone Toronto)
// OU manuel via POST /weekly-analysis?secret=<ANALYSIS_SECRET>
//
// Env requis : ANTHROPIC_API_KEY, RESEND_API_KEY, REPORT_EMAIL_TO,
//              VAPI_PRIVATE_KEY (déjà setup pour le SMS)
// ============================================================

// --- 1. FETCH des appels VAPI ---
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
  return Array.isArray(data) ? data : (data.calls || []);
}

// --- 2. PRÉ-FILTRAGE des appels « intéressants » ---
function isInterestingCall(call) {
  const durationSec = call.endedAt && call.startedAt
    ? (new Date(call.endedAt) - new Date(call.startedAt)) / 1000
    : 0;

  // Critères : trop court, trop long, raison de fin suspecte, erreur tool, échec
  if (durationSec < 30) return true;                              // raccrochage rapide = problème
  if (durationSec > 300) return true;                             // > 5 min = client s'enlise
  if (call.endedReason && /error|failed|timeout/i.test(call.endedReason)) return true;
  if (call.status === "failed") return true;

  // A-t-on des messages "je ne sais pas" / "désolé" ?
  const transcript = (call.transcript || "").toLowerCase();
  if (/je ne sais pas|je ne trouve pas|désolé|i don'?t know|sorry/i.test(transcript)) return true;

  return false;
}

function compactCallForAnalysis(call) {
  // Réduit l'objet à l'essentiel pour économiser des tokens
  return {
    id: call.id,
    assistant_id: call.assistantId || null,
    assistant_name: VAPI_ASSISTANTS_MAP[call.assistantId] || null,
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
function computeCallStats(allCalls) {
  const total = allCalls.length;
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

  const durations = [];
  const byAssistant = {};
  const byEndedReason = {};
  const byHour = {};
  let short30 = 0;
  let long5 = 0;

  for (const c of allCalls) {
    const dur = c.endedAt && c.startedAt
      ? (new Date(c.endedAt) - new Date(c.startedAt)) / 1000
      : 0;
    if (dur > 0) durations.push(dur);
    if (dur > 0 && dur < 30) short30++;
    if (dur > 300) long5++;

    const aName = VAPI_ASSISTANTS_MAP[c.assistantId] || c.assistantId || "unknown";
    byAssistant[aName] = (byAssistant[aName] || 0) + 1;

    const reason = c.endedReason || "unknown";
    byEndedReason[reason] = (byEndedReason[reason] || 0) + 1;

    if (c.startedAt) {
      try {
        const local = new Date(new Date(c.startedAt).toLocaleString("en-US", { timeZone: ANALYSIS_TIMEZONE }));
        const hour = local.getHours();
        byHour[hour] = (byHour[hour] || 0) + 1;
      } catch { /* skip bad date */ }
    }
  }

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

// --- Stats agrégées calculées DEPUIS les events in-memory drainés ---
function computeEventStats(events) {
  const productSearches = events.filter(e => e.type === "shopify_product_search");
  const orderSearches = events.filter(e => e.type === "shopify_order_search");
  const smsReceived = events.filter(e => e.type === "sms_received");
  const smsReplied = events.filter(e => e.type === "sms_replied");
  const errors = events.filter(e => e.type === "error");

  // Top queries Shopify (par fréquence)
  const queryCount = {};
  const cascadeLevelCount = {};
  let zeroResultQueries = [];
  for (const e of productSearches) {
    const q = (e.query || "").trim().toLowerCase();
    if (q) queryCount[q] = (queryCount[q] || 0) + 1;
    cascadeLevelCount[e.cascade_level] = (cascadeLevelCount[e.cascade_level] || 0) + 1;
    if (e.results_count === 0 && q) zeroResultQueries.push(q);
  }
  // Dédupliquer avec compte
  const zeroResultCount = {};
  for (const q of zeroResultQueries) zeroResultCount[q] = (zeroResultCount[q] || 0) + 1;

  const topQueries = Object.entries(queryCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  const topZeroResultQueries = Object.entries(zeroResultCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([query, count]) => ({ query, count }));

  // SMS : sessions uniques (via phone_hash distincts dans sms_received)
  const uniquePhones = new Set(smsReceived.map(e => e.phone_hash).filter(Boolean));
  const newSessions = smsReceived.filter(e => e.is_new_session).length;
  const latencies = smsReplied.map(e => e.latency_ms).filter(n => typeof n === "number");
  const avgSmsLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  // Orders : taux trouvé
  const ordersFound = orderSearches.filter(e => e.found).length;

  // Errors par where
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

// --- 3. ANALYSE par Claude Sonnet 4.6 ---
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

async function analyzeWithClaude(calls, statsContext = null) {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");

  const statsBlock = statsContext
    ? `\nMÉTRIQUES OBJECTIVES DE LA SEMAINE (toute la base, pas juste les appels ci-dessous) :
${JSON.stringify(statsContext, null, 2)}

Utilise ces métriques pour contextualiser ton analyse. Par exemple : si "top_zero_result_queries" contient "filtreur" 6 fois, c'est probablement un synonyme manquant majeur.\n`
    : "";

  const userMessage = `Voici ${calls.length} transcripts d'appels intéressants de la semaine écoulée. Analyse-les et produis le rapport JSON.
${statsBlock}
${calls.map((c, i) => `--- APPEL ${i + 1} (id: ${c.id}, assistant: ${c.assistant_name || c.assistant_id || "?"}, durée: ${c.duration_sec}s, fin: ${c.ended_reason}, tools: ${c.tool_calls_made.join(", ") || "aucun"}) ---
${c.transcript}
`).join("\n\n")}`;

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
      // Force Claude à utiliser ce tool spécifique — garantit JSON valide selon le schéma
      tool_choice: { type: "tool", name: "submit_weekly_report" },
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API HTTP ${response.status}: ${text}`);
  }

  const data = await response.json();

  // Avec tool_use forcé, Claude DOIT appeler submit_weekly_report — on extrait l'input
  const toolUseBlock = (data.content || []).find(
    b => b.type === "tool_use" && b.name === "submit_weekly_report"
  );

  if (!toolUseBlock || !toolUseBlock.input) {
    throw new Error(`Claude n'a pas appelé submit_weekly_report. Réponse brute: ${JSON.stringify(data.content).slice(0, 800)}`);
  }

  const report = toolUseBlock.input;
  const cost_usd = data.usage
    ? ((data.usage.input_tokens * 3 + data.usage.output_tokens * 15) / 1_000_000)
    : null;

  return { report, cost_usd, raw_text: JSON.stringify(data.content) };
}

// --- 4. FORMATAGE HTML du rapport pour le courriel ---
function reportToHtml(report, meta) {
  const escapeHtml = s => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const issuesList = (report.top_issues || []).map(i => `
    <li style="margin-bottom: 16px;">
      <strong>#${escapeHtml(i.rank)} — ${escapeHtml(i.issue)}</strong> <em>(${escapeHtml(i.frequency)})</em><br>
      <strong>Cause :</strong> ${escapeHtml(i.root_cause)}<br>
      <strong>Fix proposé :</strong> ${escapeHtml(i.proposed_fix)}<br>
      <strong>Où appliquer :</strong> <code>${escapeHtml(i.fix_location)}</code><br>
      <em>Extrait :</em> ${escapeHtml(i.example_transcript_excerpt)}
    </li>`).join("");

  const synonymsList = (report.missing_synonyms || []).map(s =>
    `<li><code>${escapeHtml(s.word_heard)}</code> → <code>${escapeHtml(s.should_match)}</code> (${escapeHtml(s.context)})</li>`
  ).join("");

  const gapsList = (report.knowledge_gaps || []).map(g => `<li>${escapeHtml(g)}</li>`).join("");
  const winsList = (report.wins || []).map(w => `<li>${escapeHtml(w)}</li>`).join("");

  // Section métriques objectives
  const stats = meta.stats || null;
  let metricsHtml = "";
  if (stats) {
    const c = stats.calls;
    const e = stats.events;

    const assistantRows = Object.entries(c.by_assistant || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `<li>${escapeHtml(name)} : <strong>${n}</strong> appel(s)</li>`).join("");

    const reasonRows = Object.entries(c.by_ended_reason || {})
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `<li><code>${escapeHtml(reason)}</code> : ${n}</li>`).join("");

    const peakHours = Object.entries(c.by_hour_local || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([h, n]) => `${h}h : ${n}`).join(" · ");

    const topQ = (e.product_searches?.top_queries || [])
      .map(q => `<li><code>${escapeHtml(q.query)}</code> — ${q.count}×</li>`).join("");
    const zeroQ = (e.product_searches?.top_zero_result_queries || [])
      .map(q => `<li><code>${escapeHtml(q.query)}</code> — ${q.count}× <em>(0 résultat)</em></li>`).join("");
    const cascade = Object.entries(e.product_searches?.cascade_level_distribution || {})
      .map(([lvl, n]) => `<code>${escapeHtml(lvl)}</code>: ${n}`).join(" · ");

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

// --- 5. ENVOI courriel via Resend ---
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

// --- 6. ORCHESTRATION ---
async function runWeeklyAnalysis() {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log(`[coach] Starting weekly analysis ${startDate.toISOString()} → ${endDate.toISOString()}`);

  const allCalls = await fetchVapiCalls(startDate, endDate);
  console.log(`[coach] Fetched ${allCalls.length} calls`);

  // Snapshot des events SANS drain (drain seulement après email envoyé avec succès)
  const eventsSnapshot = peekEvents();
  const callStats = computeCallStats(allCalls);
  const eventStats = computeEventStats(eventsSnapshot);
  const stats = { calls: callStats, events: eventStats };
  console.log(`[coach] Stats: ${callStats.total_calls} calls, ${eventsSnapshot.length} events captured`);

  const meta = {
    total_fetched: allCalls.length,
    cost_usd: 0,
    stats,
    period: `${startDate.toISOString().split("T")[0]} → ${endDate.toISOString().split("T")[0]}`,
  };

  if (allCalls.length === 0 && eventsSnapshot.length === 0) {
    console.log(`[coach] No calls and no events this period, skipping analysis.`);
    return { skipped: true, reason: "no_activity" };
  }

  const interesting = allCalls.filter(isInterestingCall).map(compactCallForAnalysis);
  console.log(`[coach] ${interesting.length} interesting calls after pre-filtering`);

  let report;
  let cost_usd = 0;

  if (interesting.length === 0) {
    // Pas d'appel problématique : mini-rapport positif, on envoie quand même les métriques
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
    const result = await analyzeWithClaude(interesting, stats);
    report = result.report;
    cost_usd = result.cost_usd;
    console.log(`[coach] Claude analysis done. Cost: $${cost_usd?.toFixed(4)}`);
  }

  meta.cost_usd = cost_usd;
  await sendEmailReport(report, meta);
  console.log(`[coach] Email sent to ${REPORT_EMAIL_TO}`);

  // Drain APRÈS succès email — si crash avant ici, on garde les events pour la prochaine fois
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

// --- 7. ENDPOINT manuel + déclencheur cron interne ---
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

// Cron interne : check toutes les 60 min, déclenche dimanche 23h, timezone Toronto
// Réliable même si Railway redémarre (la fenêtre 23:00–23:59 du dimanche couvre le redémarrage)
let lastWeeklyRunDate = null;
setInterval(async () => {
  try {
    const now = new Date();
    const local = new Date(now.toLocaleString("en-US", { timeZone: ANALYSIS_TIMEZONE }));
    const todayStr = local.toISOString().split("T")[0];

    if (local.getDay() === 0 && local.getHours() === 23 && lastWeeklyRunDate !== todayStr) {
      lastWeeklyRunDate = todayStr;
      console.log(`[coach] CRON triggered at ${local.toISOString()} (local TZ ${ANALYSIS_TIMEZONE})`);
      const result = await runWeeklyAnalysis();
      console.log(`[coach] CRON done:`, JSON.stringify(result).slice(0, 200));
    }
  } catch (err) {
    console.error("[coach] CRON failed:", err);
  }
}, 60 * 60 * 1000); // 60 minutes


// ============================================================
// HEALTH CHECK
// ============================================================

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
    assistants_map_loaded: Object.keys(VAPI_ASSISTANTS_MAP).length,
    sms_sessions_active: smsSessions.size,
    events_buffered: EVENTS.length,
    api_version: SHOPIFY_API_VERSION,
  });
});

// Stats live des events in-memory (depuis le dernier drain par le coach)
// Pratique pour debug : voir en temps réel les recherches, erreurs, SMS de la journée.
app.get("/events/stats", (_req, res) => {
  const events = peekEvents();
  res.json({
    ok: true,
    events_buffered: events.length,
    buffered_since: events[0]?.ts || null,
    stats: computeEventStats(events),
  });
});


// ============================================================
// ROUTE — POST /search_shopify_orders  (tool VAPI)
// Lookup d'une commande par n° (#1234 ou 1234)
// Retourne : statut paiement + statut fulfillment + items achetés
// Permission Shopify requise : scope `read_orders` sur l'app custom
// ============================================================

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
        }
      }
    }
  }
`;

// Traduit les statuts Shopify (en majuscules) en libellés FR courts pour l'IA
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

function formatOrder(o) {
  const items = (o.lineItems?.edges || []).map(e => ({
    title: e.node.title,
    quantity: e.node.quantity,
    variant: e.node.variantTitle || null,
    sku: e.node.sku || null,
  }));

  const financial = o.displayFinancialStatus || "UNKNOWN";
  const fulfillment = o.displayFulfillmentStatus || "UNKNOWN";

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
  };
}

app.post("/search_shopify_orders", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);
  const start = Date.now();

  try {
    // Accepter n'importe lequel des noms de champ que l'IA pourrait utiliser
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

    // Normalise : retire tout ce qui n'est pas chiffre/lettre puis ajoute # devant si manquant
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

    const shopifyQuery = `name:#${cleaned}`;

    const data = await fetchShopifyGraphQL(ORDER_GQL, { q: shopifyQuery });
    const orders = (data.orders?.edges || []).map(e => formatOrder(e.node));
    const ms = Date.now() - start;

    console.log(`[search_shopify_orders] input="${raw}" query="${shopifyQuery}" found=${orders.length} ms=${ms}ms`);

    logEvent("shopify_order_search", {
      order_number: cleaned,
      found: orders.length > 0,
      count: orders.length,
      ms,
    });

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

    const main = orders[0];
    const summary = `Commande ${main.order_number} du ${new Date(main.created_at).toLocaleDateString("fr-CA")} : ${main.financial_status_fr}, ${main.fulfillment_status_fr}. ${main.items_count} article(s) : ${main.items.map(i => `${i.quantity}× ${i.title}`).join(", ")}.`;

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


// ============================================================
// DIAGNOSTIC SHOPIFY — vérifie auth + liste 3 produits sample
// Hit depuis le navigateur : /diagnose-shopify
// ============================================================

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


// ============================================================
// LISTEN
// ============================================================

app.listen(PORT, () => {
  console.log(`[BOOT] Server listening on port ${PORT}`);
  console.log(`[BOOT] Shopify domain: ${SHOPIFY_DOMAIN || "(missing)"}`);
  console.log(`[BOOT] Shopify API version: ${SHOPIFY_API_VERSION}`);
});
