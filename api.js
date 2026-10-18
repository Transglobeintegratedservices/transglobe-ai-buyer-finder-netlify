"use strict";

// Netlify Functions adapter for Transglobe AI Buyer Finder.
// Search keys are read only from Netlify's server-side environment.

const crypto = require("node:crypto");
const core = require("../../server.js");

let leads = [];
let lastRun = null;
let lastRunError = null;

const SERVICE_LABELS = {
  topsoil: "Topsoil supply",
  landscaping: "Landscaping",
  haulage: "Haulage",
  procurement: "Procurement & logistics",
  "site support": "Site support"
};

const services = Object.keys(SERVICE_LABELS);

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

const reply = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body)
});

const parseBody = (event) => {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    throw new Error("Invalid JSON body.");
  }
};

const safeUrl = (raw) => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
};

function validate(input, prior = {}) {
  const x = { ...prior, ...input };

  x.name = String(x.name || "").trim().slice(0, 250);

  if (!x.name) {
    throw new Error("Business / prospect name is required.");
  }

  x.service = String(x.service || "Multiple services").slice(0, 100);
  x.location = String(x.location || "").slice(0, 150);

  if (
    ![
      "Active Buyer",
      "Project Opportunity",
      "Potential Client",
      "Unverified"
    ].includes(x.intent)
  ) {
    x.intent = "Unverified";
  }

  if (
    ![
      "New",
      "Verification pending",
      "Qualified",
      "Contacted",
      "Interested",
      "Quotation requested",
      "Quotation sent",
      "Won",
      "Lost",
      "Not a fit"
    ].includes(x.status)
  ) {
    x.status = "New";
  }

  if (!["High", "Medium", "Low"].includes(x.priority)) {
    x.priority = "Medium";
  }

  x.score = Math.max(0, Math.min(100, Number(x.score) || 0));

  x.source = x.source ? safeUrl(x.source) : "";

  if (input.source && !x.source) {
    throw new Error("Source URL must use HTTPS.");
  }

  for (const k of [
    "email",
    "phone",
    "followup",
    "notes",
    "need",
    "sourceTitle"
  ]) {
    x[k] = String(x[k] || "").slice(0, 1200);
  }

  return x;
}

async function discover(options = {}) {
  if (
    !process.env.LANGSEARCH_API_KEY &&
    !process.env.SERPAPI_KEY
  ) {
    throw new Error(
      "Live search is not configured. Confirm LANGSEARCH_API_KEY is set for Netlify Functions, then redeploy."
    );
  }

  const location = String(
    options.location || "Lagos, Nigeria"
  ).slice(0, 100);

  const mode = ["both", "active", "potential"].includes(options.mode)
    ? options.mode
    : "both";

  const selected = Array.isArray(options.services)
    ? options.services.filter((s) => services.includes(s))
    : ["topsoil", "landscaping"];

  const queries = core.queriesFor({
    location,
    mode,
    selectedServices: selected,
    extraQuery: String(options.extraQuery || "").slice(0, 180)
  });

  const found = [];
  const failures = [];

  // Nigerian locations used to verify geographic relevance.
  const nigeriaTerms =
    /\b(nigeria|nigerian|lagos|lekki|ajah|ikeja|ikorodu|badagry|epe|ogun|abeokuta|ibadan|abuja|port harcourt|enugu|benin city|warri|uyo|calabar|ilorin|kaduna|kano|jos|asaba|ondo|osun|oyo|kwara|anambra|delta state|rivers state|federal capital territory)\b/i;

  // Overseas locations that may indicate irrelevant results.
  const overseasTerms =
    /\b(australia|australian|new zealand|united states|canada|united kingdom|england|scotland|wales|ireland|south africa|kenya|ghana|india|pakistan|bangladesh|singapore|malaysia|philippines)\b/i;

  // Country-code domains commonly associated with other markets.
  const overseasDomains =
    /\.(com\.au|net\.au|org\.au|edu\.au|gov\.au|co\.uk|org\.uk|ac\.uk|nz|ca|za|ke|gh|in|pk|sg|my|ph)$/i;

  for (const item of queries) {
    try {
      const results = await core.searchLangSearch(item.query);

      for (const r of results) {
        const text = `${r.title || ""} ${r.snippet || ""}`;

        let hostname = "";

        try {
          hostname = new URL(r.link).hostname
            .toLowerCase()
            .replace(/^www\./, "");
        } catch {
          continue;
        }

        if (!hostname) {
          continue;
        }

        // Require Nigerian location evidence in the result text.
        if (!nigeriaTerms.test(text)) {
          continue;
        }

        // Reject clearly overseas results when Nigerian evidence
        // is absent. This is a safeguard, not proof of buyer intent.
        if (
          overseasTerms.test(text) &&
          !nigeriaTerms.test(text)
        ) {
          continue;
        }

        // Exclude country-code domains associated with other markets.
        if (overseasDomains.test(hostname)) {
          continue;
        }

        // Retain the existing service-relevance and intent classifier.
        const classification = core.classify(
          r,
          item.service,
          mode
        );

        if (!classification) {
          continue;
        }

        found.push({
          ...r,
          ...classification,
          service: SERVICE_LABELS[item.service],
          query: item.query
        });
      }
    } catch (e) {
      failures.push({
        query: item.query,
        error: String(e.message || "Search failed")
      });
    }
  }

  // Avoid adding duplicate source links within the current function memory.
  const seen = new Set(
    leads.map((x) => x.source).filter(Boolean)
  );

  const added = [];

  for (const r of found) {
    const source = core.canonicalLink(r.link);

    if (!source || seen.has(source)) {
      continue;
    }

    seen.add(source);

    const lead = {
      id: crypto.randomUUID(),
      name:
        r.sourceName ||
        new URL(source).hostname.replace(/^www\./, ""),
      service: r.service,
      location,
      intent: r.intent,
      priority: r.priority,
      score: r.score,
      status: "Verification pending",
      email: "",
      phone: "",
      followup: "",
      source,
      sourceTitle: r.title,
      need: r.snippet,
      notes:
        `Discovered via public web search. Query: ${r.query}` +
        (r.date ? `; source date: ${r.date}` : ""),
      sourceDate: r.date || "",
      discoveredAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      archived: false
    };

    added.push(lead);
  }

  leads = [...added, ...leads];

  lastRun = {
    at: new Date().toISOString(),
    queriesRun: queries.length,
    results: found.length,
    newLeads: added.length,
    duplicates: found.length - added.length,
    failures
  };

  lastRunError =
    failures.length === queries.length
      ? failures[0]?.error || "All searches failed"
      : null;

  if (queries.length && failures.length === queries.length) {
    throw new Error(
      `All ${queries.length} search queries failed. ${lastRunError}`
    );
  }

  return {
    ...lastRun,
    leads: added
  };
}

exports.handler = async (event) => {
  const path =
    event.queryStringParameters?.path || "/api/health";

  const method = event.httpMethod || "GET";

  try {
    if (method === "GET" && path === "/api/health") {
      return reply(200, {
        ok: true,
        version: "2.1.0-netlify",
        searchConfigured: Boolean(
          process.env.LANGSEARCH_API_KEY ||
          process.env.SERPAPI_KEY
        ),
        searchProvider: process.env.LANGSEARCH_API_KEY
          ? "LangSearch"
          : process.env.SERPAPI_KEY
            ? "SerpApi (legacy)"
            : "Not configured",
        langSearchConfigured: Boolean(
          process.env.LANGSEARCH_API_KEY
        ),
        aiConfigured: Boolean(process.env.OPENAI_API_KEY),
        schedulerRunning: false,
        databaseReady: true,
        storageMode:
          "temporary function memory; use managed storage for durable leads",
        lastRun,
        lastRunError,
        intervalHours: Number(
          process.env.SEARCH_INTERVAL_HOURS || 6
        ),
        authRequired: false
      });
    }

    if (method === "GET" && path === "/api/leads") {
      return reply(200, {
        leads: leads.filter((x) => !x.archived)
      });
    }

    if (method === "GET" && path === "/api/run-status") {
      return reply(200, {
        lastRun,
        lastRunError
      });
    }

    if (method === "POST" && path === "/api/discover") {
      try {
        return reply(200, await discover(parseBody(event)));
      } catch (e) {
        lastRunError = e.message;
        return reply(503, {
          error: e.message
        });
      }
    }

    if (method === "POST" && path === "/api/leads") {
      const x = validate(parseBody(event));

      x.id = crypto.randomUUID();
      x.createdAt = new Date().toISOString();
      x.archived = false;

      leads.unshift(x);

      return reply(201, {
        lead: x
      });
    }

    const match = path.match(/^\/api\/leads\/([a-f0-9-]+)$/i);

    if (match && method === "PATCH") {
      const i = leads.findIndex(
        (x) => x.id === match[1] && !x.archived
      );

      if (i < 0) {
        return reply(404, {
          error: "Lead not found."
        });
      }

      leads[i] = validate(parseBody(event), leads[i]);

      return reply(200, {
        lead: leads[i]
      });
    }

    if (match && method === "DELETE") {
      const i = leads.findIndex(
        (x) => x.id === match[1] && !x.archived
      );

      if (i < 0) {
        return reply(404, {
          error: "Lead not found."
        });
      }

      leads[i].archived = true;

      return reply(200, {
        ok: true
      });
    }

    return reply(404, {
      error: "API route not found."
    });
  } catch (e) {
    return reply(500, {
      error: String(e.message || "Internal server error.")
    });
  }
};
