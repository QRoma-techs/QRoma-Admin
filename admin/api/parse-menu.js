// Netlify Function: parse-menu
// Securely proxies a PDF menu to the Anthropic API for extraction.
// The API key lives ONLY in Netlify env vars (server-side) — never in the browser.
//
// Setup (one-time):
//   1. Netlify dashboard → Site settings → Environment variables
//      Add:  ANTHROPIC_API_KEY = sk-ant-...   (your key)
//   2. (optional) ALLOWED_ORIGIN = https://qroma.in   to lock CORS to your domain
//   3. Deploy. The endpoint becomes  /.netlify/functions/parse-menu

const MODEL = "claude-sonnet-4-20250514";
const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8MB

const EXTRACT_PROMPT = `You are a menu data extractor. Read this restaurant menu PDF and extract every food/drink item. Return ONLY a JSON array (no markdown, no prose, no code fences). Each element must be an object with exactly these keys:
- "name": string (item name)
- "category": string (best-guess category like "Starters", "Mains", "Beverages", "Desserts" — infer from headings)
- "price": number (numeric only, no currency symbol; if a range, use the lower value; if missing, use 0)
- "veg": boolean (true if vegetarian/veg, false if non-veg; infer from context, default true if unclear)

Return [] if no items found. Output strictly valid JSON only.`;

exports.handler = async (event) => {
  const allowOrigin = process.env.ALLOWED_ORIGIN || "*";
  const cors = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Server not configured: ANTHROPIC_API_KEY missing" }) };
  }

  // Parse body
  let pdfBase64;
  try {
    const body = JSON.parse(event.body || "{}");
    pdfBase64 = body.pdfBase64;
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  if (!pdfBase64 || typeof pdfBase64 !== "string") {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing pdfBase64" }) };
  }
  // Rough size check (base64 is ~1.37x the binary size)
  if (pdfBase64.length * 0.75 > MAX_PDF_BYTES) {
    return { statusCode: 413, headers: cors, body: JSON.stringify({ error: "PDF too large (max 8MB)" }) };
  }

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: EXTRACT_PROMPT },
          ],
        }],
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text();
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "AI request failed", status: aiRes.status, detail: detail.slice(0, 500) }) };
    }

    const data = await aiRes.json();
    let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    let items;
    try {
      items = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\[[\s\S]*\]/);
      if (m) { items = JSON.parse(m[0]); }
      else { return { statusCode: 200, headers: cors, body: JSON.stringify({ items: [], warning: "AI returned unreadable data" }) }; }
    }

    if (!Array.isArray(items)) items = [];

    // Normalise server-side too (defensive)
    const clean = items.map(it => ({
      name: String(it.name || "").trim(),
      category: String(it.category || "Uncategorized").trim(),
      price: (() => { const p = parseFloat(it.price); return isNaN(p) ? 0 : p; })(),
      veg: it.veg !== false,
    })).filter(it => it.name);

    return { statusCode: 200, headers: cors, body: JSON.stringify({ items: clean }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Server error", detail: String(e).slice(0, 300) }) };
  }
};
