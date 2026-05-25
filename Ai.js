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

function buildShopifyQuery({ tokens, vendor, productType, tags, inStockOnly, level }) {
  const parts = [];

  // Bloc texte selon le niveau
  if (tokens && tokens.length > 0) {
    if (level === "STRICT") {
      // Phrase exacte dans le titre
      parts.push(`title:"${esc(tokens.join(" "))}"`);
    } else if (level === "TOKENS") {
      // Chaque token wildcardé, AND entre eux
      const block = tokens
        .map(tok => `(title:*${tok}* OR tag:*${tok}* OR product_type:*${tok}*)`)
        .join(" AND ");
      parts.push(block);
    } else if (level === "SYNONYMES") {
      // Chaque token étendu avec ses synonymes (OR interne), AND entre tokens
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        const ors = syns
          .map(s => `title:*${s}* OR tag:*${s}* OR product_type:*${s}* OR vendor:*${s}*`)
          .join(" OR ");
        return `(${ors})`;
      }).join(" AND ");
      parts.push(block);
    } else if (level === "FILTERS_OFF") {
      // Mêmes tokens+synonymes mais on retire vendor/type/tags pour élargir
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        const ors = syns.map(s => `title:*${s}* OR tag:*${s}*`).join(" OR ");
        return `(${ors})`;
      }).join(" AND ");
      parts.push(block);
    } else if (level === "KEYWORD") {
      // Uniquement le token le plus long (le plus significatif) + ses synonymes
      const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
      const syns = expandSynonyms(longest);
      const ors = syns.map(s => `title:*${s}* OR tag:*${s}*`).join(" OR ");
      parts.push(`(${ors})`);
    } else if (level === "TAGS_ONLY") {
      // Dernier recours : recherche dans les tags seulement
      const block = tokens.map(tok => {
        const syns = expandSynonyms(tok);
        return `(${syns.map(s => `tag:*${s}*`).join(" OR ")})`;
      }).join(" OR ");
      parts.push(block);
    }
  }

  // Filtres VAPI — uniquement aux niveaux les plus stricts
  const keepStructuralFilters = level === "STRICT" || level === "TOKENS" || level === "SYNONYMES" || level === "FILTERS_ONLY";

  if (keepStructuralFilters) {
    if (vendor) parts.push(`vendor:"${esc(vendor)}"`);
    if (productType) parts.push(`product_type:"${esc(productType)}"`);
    if (tags && tags.length) {
      const tagPart = tags.map(t => `tag:"${esc(t)}"`).join(" AND ");
      parts.push(`(${tagPart})`);
    }
  }

  // Stock : contrainte dure, on la garde à tous les niveaux si demandée
  if (inStockOnly) parts.push(`inventory_total:>0`);

  // Toujours filtrer les drafts/archivés
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

const CASCADE_LEVELS = ["STRICT", "TOKENS", "SYNONYMES", "FILTERS_OFF", "KEYWORD", "TAGS_ONLY"];

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

  // Cas 1 : pas de texte, seulement des filtres
  if (tokens.length === 0) {
    const q = buildShopifyQuery({ tokens: [], vendor, productType, tags, inStockOnly, level: "FILTERS_ONLY" });
    const products = applyPriceFilter(await runShopifySearch(q, fetchCount), minPrice, maxPrice);
    return {
      products: products.slice(0, limit),
      level: "FILTERS_ONLY",
      finalQuery: q,
      widened: false,
    };
  }

  // Cas 2 : cascade textuelle
  const levels = widenIfEmpty ? CASCADE_LEVELS : CASCADE_LEVELS.slice(0, 3);

  for (const level of levels) {
    const q = buildShopifyQuery({ tokens, vendor, productType, tags, inStockOnly, level });
    let products;
    try {
      products = await runShopifySearch(q, fetchCount);
    } catch (err) {
      console.error(`[cascade] level=${level} failed:`, err.message);
      continue; // on tente le niveau suivant
    }

    products = applyPriceFilter(products, minPrice, maxPrice);

    if (products.length > 0) {
      return {
        products: products.slice(0, limit),
        level,
        finalQuery: q,
        widened: level !== "STRICT",
      };
    }
  }

  return { products: [], level: "NONE", finalQuery: null, widened: true };
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
    FILTERS_OFF: "j'ai retiré certains filtres (marque/type) pour élargir",
    KEYWORD:     "j'ai gardé seulement le mot-clé principal",
    TAGS_ONLY:   "j'ai cherché uniquement dans les catégories/tags",
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

    const { products, level, finalQuery, widened } = await cascadeSearch(searchArgs);
    const formatted = products.map(formatProduct);
    const ms = Date.now() - start;

    console.log(`[search_shopify_products] level=${level} count=${formatted.length} ms=${ms}ms query="${finalQuery}"`);

    return res.json(vapiResult(toolCallId, {
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
    }));
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
    routes: ["POST /search_shopify_products"],
    shopify_domain_configured: !!SHOPIFY_DOMAIN,
    shopify_token_configured: !!SHOPIFY_TOKEN,
    api_version: SHOPIFY_API_VERSION,
  });
});


// ============================================================
// LISTEN
// ============================================================

app.listen(PORT, () => {
  console.log(`[BOOT] Server listening on port ${PORT}`);
  console.log(`[BOOT] Shopify domain: ${SHOPIFY_DOMAIN || "(missing)"}`);
  console.log(`[BOOT] Shopify API version: ${SHOPIFY_API_VERSION}`);
});
