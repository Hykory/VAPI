// Ai.js - Node.js ES Modules prêt pour Railway

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Variables d'environnement
const PORT = process.env.PORT || 8080;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

// Helper Shopify REST
async function fetchShopify(endpoint, query = "") {

  const url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-10/${endpoint}.json${query}`;

  console.log("SHOPIFY_DOMAIN:", SHOPIFY_DOMAIN);

  console.log(
    "SHOPIFY_TOKEN starts with:",
    SHOPIFY_TOKEN?.slice(0, 6)
  );

  console.log(
    "SHOPIFY_TOKEN length:",
    SHOPIFY_TOKEN?.length
  );

  console.log("SHOPIFY URL:", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error ${response.status}: ${text}`);
  }

  return response.json();
}

// Helper Vapi
function getVapiToolCall(req) {
  const toolCall = req.body?.message?.toolCalls?.[0];

  let args = toolCall?.function?.arguments || {};

  if (typeof args === "string") {
    args = JSON.parse(args);
  }

  return {
    toolCall,
    args,
  };
}

// ====================================
// ROUTES SHOPIFY
// ====================================

app.post("/shopify/products", async (req, res) => {
  console.log("BODY VAPI PRODUCTS:");
  console.dir(req.body, { depth: null });

  try {
    const { toolCall, args } = getVapiToolCall(req);
    const query = args.query || "";

    console.log("Recherche produit:", query);

    const response = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_TOKEN,
        },
        body: JSON.stringify({
          query: `
            query SearchProducts($search: String!) {
              products(first: 20, query: $search) {
                edges {
                  node {
                    title
                    handle
                    status
                    totalInventory
                    variants(first: 20) {
                      edges {
                        node {
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
          `,
          variables: {
            search: query,
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || data.errors) {
      throw new Error(JSON.stringify(data.errors || data));
    }

    let products = data?.data?.products?.edges || [];

    const q = query.toLowerCase();

    const accessoryWords = [
      "couvert",
      "couvercle",
      "panier",
      "basket",
      "strainer",
      "joint",
      "gasket",
      "seal",
      "o-ring",
      "piece",
      "pièce",
      "accessoire",
      "cartouche",
      "filtre",
      "hose",
      "tuyau",
    ];

    const wantsPump =
      q.includes("pompe") ||
      q.includes("pump") ||
      q.includes("hp") ||
      q.includes("hors terre") ||
      q.includes("above ground");

    if (wantsPump) {
      products = products.filter(({ node }) => {
        const title = node.title.toLowerCase();

        const isAccessory = accessoryWords.some((word) =>
          title.includes(word)
        );

        return !isAccessory;
      });
    }

    if (products.length === 0) {
      return res.json({
        results: [
          {
            toolCallId: toolCall.id,
            result: `Je n'ai pas trouvé de pompe complète correspondant exactement à "${query}". Demande au client la marque, le modèle ou la puissance HP avant de conclure que le produit n'est pas disponible.`,
          },
        ],
      });
    }

    const responseText = products
      .slice(0, 5)
      .map(({ node: product }) => {
        const variantsText = product.variants.edges
          .map(({ node: variant }) => {
            const stock = variant.inventoryQuantity ?? 0;

            const stockText =
              stock > 0 || variant.availableForSale
                ? `En stock (${stock} disponible${stock > 1 ? "s" : ""})`
                : "Pas en stock actuellement";

            return `
- Variante: ${variant.title || "Standard"}
  Prix: ${variant.price} CAD
  SKU: ${variant.sku || "N/A"}
  Stock: ${stockText}
            `.trim();
          })
          .join("\n");

        return `
Produit: ${product.title}
Inventaire total: ${product.totalInventory ?? "N/A"}
Statut: ${product.status}
Lien: https://${SHOPIFY_DOMAIN}/products/${product.handle}

${variantsText}
        `.trim();
      })
      .join("\n\n");

    return res.json({
      results: [
        {
          toolCallId: toolCall.id,
          result: responseText,
        },
      ],
    });
  } catch (error) {
    console.error("Erreur Shopify Products:", error);

    const toolCallId = req.body?.message?.toolCalls?.[0]?.id || "unknown";

    return res.json({
      results: [
        {
          toolCallId,
          result: `Erreur lors de la recherche du produit: ${error.message}`,
        },
      ],
    });
  }
});

// Test GET simple
app.get("/", (req, res) => {
  res.send("Serveur en ligne. Utilisez POST /shopify/orders ou /shopify/products");
});

// Lancement du serveur
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});