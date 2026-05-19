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
// Route pour récupérer les commandes
app.post("/shopify/orders", async (req, res) => {
  console.log("BODY VAPI ORDERS:");
  console.dir(req.body, { depth: null });

  try {
    const { toolCall, args } = getVapiToolCall(req);

    const rawQuery = args.query || "";
    const orderNumber = rawQuery.startsWith("#") ? rawQuery : `#${rawQuery}`;

    console.log("Recherche commande:", orderNumber);

    const data = await fetchShopify(
      "orders",
      `?status=any&name=${encodeURIComponent(orderNumber)}`
    );

    const orders = data.orders || [];

    if (orders.length === 0) {
      return res.json({
        results: [
          {
            toolCallId: toolCall.id,
            result: `Aucune commande trouvée avec le numéro ${orderNumber}.`,
          },
        ],
      });
    }

    const order = orders[0];

    const trackingNumbers = order.fulfillments?.flatMap((fulfillment) =>
      fulfillment.tracking_numbers || []
    ) || [];

    const trackingUrls = order.fulfillments?.flatMap((fulfillment) =>
      fulfillment.tracking_urls || []
    ) || [];

    let responseText = `
Commande ${order.name}

Statut paiement: ${order.financial_status || "N/A"}
Statut livraison: ${order.fulfillment_status || "Non traitée"}

Total: ${order.total_price} ${order.currency}

Client: ${order.customer?.first_name || ""} ${order.customer?.last_name || ""}
Email: ${order.email || order.customer?.email || "N/A"}
`.trim();

    if (trackingNumbers.length > 0 || trackingUrls.length > 0) {
      responseText += `

Tracking:`;

      trackingNumbers.forEach((number, index) => {
        responseText += `

Numéro: ${number}
Lien: ${trackingUrls[index] || "N/A"}`;
      });
    } else {
      responseText += `

Aucun numéro de tracking disponible pour le moment.`;
    }

    return res.json({
      results: [
        {
          toolCallId: toolCall.id,
          result: responseText,
        },
      ],
    });
  } catch (error) {
    console.error("Erreur Shopify Orders:", error);

    const toolCallId = req.body?.message?.toolCalls?.[0]?.id || "unknown";

    return res.json({
      results: [
        {
          toolCallId,
          result: `Erreur lors de la récupération de la commande: ${error.message}`,
        },
      ],
    });
  }
});

//route pour rechercher des produits

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
              products(first: 50, query: $search) {
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

    const wantsPump =
      q.includes("pompe") ||
      q.includes("pump") ||
      q.includes("1.5") ||
      q.includes("hp") ||
      q.includes("helios");

    const accessoryWords = [
      "couvert",
      "couvercle",
      "panier",
      "strainer",
      "oring",
      "o-ring",
      "joint",
      "drain plug",
      "plug",
      "cable",
      "câble",
      "filtre",
      "cartouche",
      "tuyau",
      "accessoire",
      "piece",
      "pièce",
    ];

    if (wantsPump) {
      products = products.filter(({ node }) => {
        const title = node.title.toLowerCase();

        const isPump =
          title.includes("pompe") ||
          title.includes("pump");

        const isAccessory = accessoryWords.some((word) =>
          title.includes(word)
        );

        return isPump && !isAccessory;
      });
    }

    const availableProducts = products
      .map(({ node: product }) => {
        const availableVariants = product.variants.edges
          .map(({ node: variant }) => {
            const stock = variant.inventoryQuantity ?? 0;

            return {
              title: variant.title || "Standard",
              price: variant.price,
              stock,
            };
          })
          .filter((variant) => variant.stock > 0);

        return {
          title: product.title,
          variants: availableVariants,
        };
      })
      .filter((product) => product.variants.length > 0);

    if (availableProducts.length === 0) {
      return res.json({
        results: [
          {
            toolCallId: toolCall.id,
            result: `Je n'ai trouvé aucun produit en stock correspondant à "${query}". Demande au client plus de détails comme la marque, le modèle, la grandeur ou la puissance.`,
          },
        ],
      });
    }

    const responseText = availableProducts
      .slice(0, 3)
      .map((product) => {
        const variantsText = product.variants
          .slice(0, 3)
          .map((variant) => {
            const variantName =
              variant.title && variant.title !== "Default Title"
                ? `, variante ${variant.title}`
                : "";

            return `${product.title}${variantName} : ${variant.price} CAD, ${variant.stock} en stock.`;
          })
          .join(" ");

        return variantsText;
      })
      .join(" ");

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