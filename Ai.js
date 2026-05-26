// ============================================================
// Ai.js — VAPI ↔ Shopify bridge (Railway, Node ES Modules)
// Route principale : POST /search_shopify_products
// ============================================================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

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

if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
  console.warn("[BOOT] WARNING: SHOPIFY_DOMAIN or SHOPIFY_TOKEN missing — Shopify calls will fail.");
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
// HEALTH CHECK
// ============================================================

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "VAPI ↔ Shopify bridge",
    routes: [
      "POST /search_shopify_products",
      "POST /search_shopify_orders",
      "GET /diagnose-shopify",
    ],
    shopify_domain_configured: !!SHOPIFY_DOMAIN,
    shopify_token_configured: !!SHOPIFY_TOKEN,
    api_version: SHOPIFY_API_VERSION,
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
          customer {
            firstName
            lastName
            email
          }
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
    customer_name: o.customer
      ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(" ").trim() || null
      : null,
    customer_email: o.customer?.email || null,
    items,
    items_count: items.length,
  };
}

app.post("/search_shopify_orders", async (req, res) => {
  const { toolCallId, args } = getVapiToolCall(req);
  const start = Date.now();

  try {
    // Accepter order_number, order_id, ou number (l'IA peut envoyer un de ces noms)
    const raw = String(args.order_number ?? args.order_id ?? args.number ?? "").trim();

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
