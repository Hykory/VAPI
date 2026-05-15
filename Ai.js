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

// Helper pour faire une requête Shopify
async function fetchShopify(endpoint, query = "") {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/2023-04/${endpoint}.json${query}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
    },
  });
  return res.json();
}

// ====================================
// ROUTES SHOPIFY
// ====================================

// Route pour récupérer les commandes
app.post("/shopify/orders", async (req, res) => {
  try {
    const query = req.body?.message?.toolCalls?.[0]?.function?.arguments?.query || "";
    const data = await fetchShopify("orders", `?name=${query}`);
    res.json({ found: true, orders: data.orders || [] });
  } catch (error) {
    console.error("Erreur Shopify Orders:", error);
    res.json({ found: false, error: "Erreur lors de la récupération des commandes." });
  }
});

// Route pour récupérer les produits
app.post("/shopify/products", async (req, res) => {
  try {
    const query = req.body?.message?.toolCalls?.[0]?.function?.arguments?.query || "";
    const data = await fetchShopify("products", `?title=${query}`);
    res.json({ found: true, products: data.products || [] });
  } catch (error) {
    console.error("Erreur Shopify Products:", error);
    res.json({ found: false, error: "Erreur lors de la récupération des produits." });
  }
});

// Test GET simple pour vérifier si le serveur fonctionne
app.get("/", (req, res) => {
  res.send("Serveur en ligne. Utilisez POST /shopify/orders ou /shopify/products");
});

// Lancement du serveur
app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});