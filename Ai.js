// ============================================================
// Ai.js - Node.js ES Modules prêt pour Railway
// ============================================================

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();


// ============================================================
// MIDDLEWARES
// ============================================================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ============================================================
// VARIABLES D'ENVIRONNEMENT
// ============================================================

const PORT = process.env.PORT || 8080;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;


// ============================================================
// FIX __dirname FOR ES MODULES
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// ============================================================
// HELPER - REQUÊTE SHOPIFY REST
// ============================================================

async function fetchShopify(endpoint, query = "") {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/2026-04/${endpoint}.json${query}`;

  console.log("SHOPIFY_DOMAIN:", SHOPIFY_DOMAIN);
  console.log("SHOPIFY_TOKEN starts with:", SHOPIFY_TOKEN?.slice(0, 6));
  console.log("SHOPIFY_TOKEN length:", SHOPIFY_TOKEN?.length);
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


// ============================================================
// HELPER - RÉCUPÉRER TOOL CALL VAPI
// ============================================================

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


// ============================================================
// HELPER - NORMALISER LES RECHERCHES PRODUITS
// ============================================================

function normalizeProductQuery(value = "") {
  return value
    .toLowerCase()
    .replace(/hélios/g, "helios")};