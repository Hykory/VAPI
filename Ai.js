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

// Route pour récupérer les produits
app.post("/shopify/products", async (req, res) => {
  console.log("BODY VAPI PRODUCTS:");
  console.dir(req.body, { depth: null });

  try {
    const { toolCall, args } = getVapiToolCall(req);

    const query = args.query || "";

    console.log("Recherche produit:", query);

    const data = await fetchShopify(
  "products",
  `?limit=250&status=active&title=${encodeURIComponent(query)}`
    );

    const products = data.products || [];

    const search = query.toLowerCase();

    const matchedProducts = products.filter((product) => {
      const titleMatch = product.title?.toLowerCase().includes(search);

      const variantMatch = product.variants?.some((variant) =>
        variant.title?.toLowerCase().includes(search) ||
        variant.sku?.toLowerCase().includes(search)
      );

      return titleMatch || variantMatch;
    });

    if (matchedProducts.length === 0) {
      return res.json({
        results: [
          {
            toolCallId: toolCall.id,
            result: `Je n'ai trouvé aucun produit correspondant à "${query}".`,
          },
        ],
      });
    }

    const responseText = matchedProducts
      .slice(0, 5)
      .map((product) => {
        const variantsText = product.variants
          .map((variant) => {
            const stock = variant.inventory_quantity ?? 0;

            const stockMessage =
              stock > 0
                ? `En stock (${stock} disponible${stock > 1 ? "s" : ""})`
                : "Pas en stock actuellement";

            return `
- Variante: ${variant.title || "Standard"}
  Prix: ${variant.price} CAD
  SKU: ${variant.sku || "N/A"}
  Stock: ${stockMessage}
            `.trim();
          })
          .join("\n");

        return `
Produit: ${product.title}
Statut Shopify: ${product.status}
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