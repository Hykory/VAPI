// ============================================================
// IMPORTS ET CONFIGURATION
// ============================================================
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(bodyParser.json());
import cors from 'cors';
app.use(cors());
// ============================================================
// CONFIGURATION SHOPIFY
// ============================================================
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;       // barracudaspas.myshopify.com
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;        // shpat_...

async function shopifyRequest(query) {
  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify API error: ${response.status} - ${text}`);
  }

  return response.json();
}

// ============================================================
// ROUTE — RECHERCHE DE PRODUITS
// ============================================================
app.post("/shopify/products", async (req, res) => {
  const query = req.body?.message?.toolCalls?.[0]?.function?.arguments?.query || "";
  console.log("Recherche produit:", query);

  try {
    const data = await shopifyRequest(`
      {
        products(first: 5, query: "${query}") {
          edges {
            node {
              title
              totalInventory
              variants(first: 5) {
                edges {
                  node {
                    title
                    price
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `);

    const products = data?.data?.products?.edges || [];

    const result = products.length === 0
      ? { found: false, message: "Aucun produit trouvé pour cette recherche." }
      : {
          found: true,
          products: products.map(({ node }) => ({
            title: node.title,
            totalStock: node.totalInventory,
            variants: node.variants.edges.map(({ node: v }) => ({
              format: v.title !== "Default Title" ? v.title : null,
              price: `${v.price} CAD`,
              stock: v.inventoryQuantity,
            })),
          })),
        };

    res.json({
      results: [{ toolCallId: req.body?.message?.toolCalls?.[0]?.id, result: JSON.stringify(result) }]
    });

  } catch (error) {
    console.error("Erreur produits:", error);
    res.json({
      results: [{ toolCallId: req.body?.message?.toolCalls?.[0]?.id, result: JSON.stringify({ error: error.message }) }]
    });
  }
});

// ============================================================
// ROUTE — RECHERCHE DE COMMANDES
// ============================================================
app.post("/shopify/orders", async (req, res) => {
  const query = req.body?.message?.toolCalls?.[0]?.function?.arguments?.query || "";
  console.log("Recherche commande:", query);

  try {
    const data = await shopifyRequest(`
      {
        orders(first: 3, query: "name:${query}") {
          edges {
            node {
              name
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                firstName
                lastName
                email
              }
              fulfillments {
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
    `);

    const orders = data?.data?.orders?.edges || [];

    const result = orders.length === 0
      ? { found: false, message: "Aucune commande trouvée avec ce numéro." }
      : {
          found: true,
          orders: orders.map(({ node }) => ({
            orderNumber: node.name,
            customer: node.customer ? `${node.customer.firstName} ${node.customer.lastName}` : null,
            email: node.customer?.email,
            paymentStatus: node.displayFinancialStatus,
            fulfillmentStatus: node.displayFulfillmentStatus,
            createdAt: node.createdAt,
            total: `${node.totalPriceSet.shopMoney.amount} ${node.totalPriceSet.shopMoney.currencyCode}`,
            tracking: node.fulfillments.flatMap(f =>
              f.trackingInfo.map(t => ({
                company: t.company,
                number: t.number,
                url: t.url,
              }))
            ),
          })),
        };

    res.json({
      results: [{ toolCallId: req.body?.message?.toolCalls?.[0]?.id, result: JSON.stringify(result) }]
    });

  } catch (error) {
    console.error("Erreur Shopify:", error);
    res.json({
      results: [{ toolCallId: req.body?.message?.toolCalls?.[0]?.id, result: JSON.stringify({ error: error.message }) }]
    });
  }
});

// ============================================================
// ROUTE GET TEMPORAIRE POUR TEST
// ============================================================
app.get("/shopify/orders", (req, res) => {
  res.send("Le serveur fonctionne ! Mais utilisez POST pour récupérer les commandes Shopify.");
});

// ============================================================
// LANCEMENT DU SERVEUR
// ============================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));