"use strict";

// Transglobe AI Buyer Finder V2
// Netlify Functions adapter with persistent Netlify Blobs storage.

const crypto = require("node:crypto");
const { connectLambda, getStore } = require("@netlify/blobs");
const core = require("../../server.js");

const STORE_NAME = "transglobe-ai-buyer-finder-v2";

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

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function canonicalSource(raw) {
  if (!raw) return "";

  try {
    return core.canonicalLink(raw);
  } catch {
    return "";
  }
}

function sourceIndexKey(source) {
  return `source-index/${crypto
    .createHash("sha256")
    .update(source)
    .digest("hex")}.json`;
}

function leadKey(id) {
  return `leads/${id}.json`;
}

function validate(input, prior = {}) {
  const x = { ...prior, ...input };

  x.name = String(x.name || "").trim().slice(0, 250);

  if (!x.name) {
    throw new Error("Business / prospect name is required.");
  }

  x.service = String(
    x.service || "Multiple services"
  ).slice(0, 100);

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

  x.score = Math.max(
    0,
    Math.min(100, Number(x.score) || 0)
  );

  x.source = x.source ? safeUrl(x.source) : "";

  if (input.source && !x.source) {
    throw new Error("Source URL must use HTTPS.");
  }

  for (const key of [
    "email",
    "phone",
    "followup",
    "notes",
    "need",
    "sourceTitle"
  ]) {
    x[key] = String(x[key] || "").slice(0, 5000);
  }

  return x;
}

// Read all prospects from persistent storage.
// Each prospect is stored under its own key.
async function listLeads(store) {
  const results = [];

  for await (const page of store.list({
    prefix: "leads/",
    paginate: true
  })) {
    for (const item of page.blobs || []) {
      const lead = await store.get(item.key, {
        type: "json",
        consistency: "strong"
      });

      if (lead && lead.id) {
        results.push(lead);
      }
    }
  }

  return results;
}

async function saveLead(store, lead) {
  await store.setJSON(leadKey(lead.id), lead);
}

async function getRunStatus(store) {
  return await store.get("meta/run-status.json", {
    type: "json",
    consistency: "strong"
  }) || {
    lastRun: null,
    lastRunError: null
  };
}

async function saveRunStatus(store, status) {
  await store.setJSON("meta/run-status.json", status);
}

// Search the public web using the existing LangSearch integration.
async function discover(store, options = {}) {
  if (!process.env.LANGSEARCH_API_KEY) {
    throw new Error(
      "LangSearch is not configured. Confirm LANGSEARCH_API_KEY is set in Netlify environment variables, then redeploy."
    );
  }

  const location = String(
    options.location || "Lagos, Nigeria"
  ).slice(0, 100);

  const mode = ["both", "active", "potential"].includes(
    options.mode
  )
    ? options.mode
    : "both";

  const selectedServices = Array.isArray(options.services)
    ? options.services.filter((service) =>
        services.includes(service)
      )
    : ["topsoil", "landscaping"];

  const queries = core.queriesFor({
    location,
    mode,
    selectedServices,
    extraQuery: String(options.extraQuery || "").slice(0, 180)
  });

  const found = [];
  const failures = [];

  const nigeriaTerms =
    /\b(nigeria|nigerian|lagos|lekki|ajah|ikeja|ikorodu|badagry|epe|ogun|abeokuta|ibadan|abuja|port harcourt|enugu|benin city|warri|uyo|calabar|ilorin|kaduna|kano|jos|asaba|ondo|osun|oyo|kwara|anambra|delta state|rivers state|federal capital territory)\b/i;

  const overseasDomains =
    /\.(com\.au|net\.au|org\.au|edu\.au|gov\.au|co\.uk|org\.uk|ac\.uk|nz|ca|za|ke|gh|in|pk|sg|my|ph)$/i;

  for (const item of queries) {
    try {
      const results = await core.searchLangSearch(item.query);

      for (const result of results) {
        const text =
          `${result.title || ""} ${result.snippet || ""}`;

        let hostname = "";

        try {
          hostname = new URL(result.link)
            .hostname
            .toLowerCase()
            .replace(/^www\./, "");
        } catch {
          continue;
        }

        if (!hostname) continue;

        // Require Nigerian location evidence in the result text.
        if (!nigeriaTerms.test(text)) continue;

        // Exclude domains associated with other markets.
        if (overseasDomains.test(hostname)) continue;

        const classification = core.classify(
          result,
          item.service,
          mode
        );

        if (!classification) continue;

        found.push({
          ...result,
          ...classification,
          service: SERVICE_LABELS[item.service],
          query: item.query
        });
      }
    } catch (error) {
      failures.push({
        query: item.query,
        error: String(error.message || "Search failed")
      });
    }
  }

  // Compare search results with existing persistent prospects.
  const existing = await listLeads(store);

  const seen = new Set(
    existing
      .map((lead) => canonicalSource(lead.source))
      .filter(Boolean)
  );

  const added = [];
  let duplicates = 0;

  for (const result of found) {
    const source = canonicalSource(result.link);

    if (!source || seen.has(source)) {
      duplicates++;
      continue;
    }

    const now = new Date().toISOString();

    const lead = {
      id: crypto.randomUUID(),

      name:
        result.sourceName ||
        new URL(source).hostname.replace(/^www\./, ""),

      service: result.service,
      location,
      intent: result.intent,
      priority: result.priority,
      score: result.score,

      status: "Verification pending",

      email: "",
      phone: "",
      followup: "",

      source,
      sourceTitle: result.title || "",
      need: result.snippet || "",

      notes:
        `Discovered via public web search. Query: ${result.query}` +
        (result.date ? `; source date: ${result.date}` : ""),

      sourceDate: result.date || "",
      discoveredAt: now,
      createdAt: now,
      archived: false
    };

    // Save the prospect separately to avoid rewriting the entire list.
    await saveLead(store, lead);

    try {
      // Atomically reserve the source URL against concurrent discoveries.
      const reservation = await store.setJSON(
        sourceIndexKey(source),
        {
          source,
          leadId: lead.id,
          createdAt: now
        },
        { onlyIfNew: true }
      );

      if (!reservation.modified) {
        await store.delete(leadKey(lead.id));
        seen.add(source);
        duplicates++;
        continue;
      }
    } catch (error) {
      // Remove the newly written prospect if source registration fails.
      try {
        await store.delete(leadKey(lead.id));
      } catch {
        // Preserve the original storage error.
      }

      throw error;
    }

    seen.add(source);
    added.push(lead);
  }

  const lastRun = {
    at: new Date().toISOString(),
    queriesRun: queries.length,
    results: found.length,
    newLeads: added.length,
    duplicates,
    failures
  };

  const lastRunError =
    queries.length > 0 && failures.length === queries.length
      ? failures[0]?.error || "All searches failed"
      : null;

  await saveRunStatus(store, {
    lastRun,
    lastRunError
  });

  if (queries.length > 0 && failures.length === queries.length) {
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
  try {
    // Initialise the Netlify Blobs Lambda context.
    connectLambda(event);

    const store = getStore(STORE_NAME);

    const path =
      event.queryStringParameters?.path || "/api/health";

    const method = event.httpMethod || "GET";

    // Health check and storage readiness.
    if (method === "GET" && path === "/api/health") {
      let storageReady = false;

      try {
        await store.list({ prefix: "leads/" });
        storageReady = true;
      } catch {
        storageReady = false;
      }

      const status = storageReady
        ? await getRunStatus(store)
        : { lastRun: null, lastRunError: "Storage unavailable" };

      return reply(storageReady ? 200 : 503, {
        ok: storageReady,
        version: "2.2.0-netlify",
        searchConfigured: Boolean(
          process.env.LANGSEARCH_API_KEY
        ),
        searchProvider: process.env.LANGSEARCH_API_KEY
          ? "LangSearch"
          : "Not configured",
        langSearchConfigured: Boolean(
          process.env.LANGSEARCH_API_KEY
        ),
        aiConfigured: Boolean(process.env.OPENAI_API_KEY),
        schedulerRunning: false,
        databaseReady: storageReady,
        storageMode: "Netlify Blobs persistent storage",
        lastRun: status.lastRun,
        lastRunError: status.lastRunError,
        intervalHours: Number(
          process.env.SEARCH_INTERVAL_HOURS || 6
        ),
        authRequired: false
      });
    }

    // List active prospects.
    if (method === "GET" && path === "/api/leads") {
      const leads = await listLeads(store);

      return reply(200, {
        leads: leads.filter((lead) => !lead.archived)
      });
    }

    // Retrieve the most recent discovery status.
    if (method === "GET" && path === "/api/run-status") {
      return reply(200, await getRunStatus(store));
    }

    // Run live discovery.
    if (method === "POST" && path === "/api/discover") {
      try {
        const result = await discover(store, parseBody(event));

        return reply(200, result);
      } catch (error) {
        const previous = await getRunStatus(store).catch(() => ({
          lastRun: null
        }));

        await saveRunStatus(store, {
          lastRun: previous.lastRun || null,
          lastRunError: String(
            error.message || "Live discovery failed."
          )
        }).catch(() => {});

        return reply(503, {
          error: String(
            error.message || "Live discovery failed."
          )
        });
      }
    }

    // Create a prospect manually.
    if (method === "POST" && path === "/api/leads") {
      const lead = validate(parseBody(event));

      lead.id = crypto.randomUUID();
      lead.createdAt = new Date().toISOString();
      lead.updatedAt = lead.createdAt;
      lead.archived = false;

      await saveLead(store, lead);

      return reply(201, { lead });
    }

    const match = path.match(
      /^\/api\/leads\/([a-f0-9-]+)$/i
    );

    // Update an existing prospect.
    if (match && method === "PATCH") {
      const leads = await listLeads(store);

      const existing = leads.find(
        (lead) =>
          lead.id === match[1] && !lead.archived
      );

      if (!existing) {
        return reply(404, {
          error: "Lead not found."
        });
      }

      const updated = validate(
        parseBody(event),
        existing
      );

      updated.id = existing.id;
      updated.createdAt = existing.createdAt;
      updated.updatedAt = new Date().toISOString();
      updated.archived = false;

      await saveLead(store, updated);

      return reply(200, { lead: updated });
    }

    // Archive a prospect without permanently deleting it.
    if (match && method === "DELETE") {
      const leads = await listLeads(store);

      const existing = leads.find(
        (lead) =>
          lead.id === match[1] && !lead.archived
      );

      if (!existing) {
        return reply(404, {
          error: "Lead not found."
        });
      }

      existing.archived = true;
      existing.updatedAt = new Date().toISOString();
      existing.archivedAt = existing.updatedAt;

      await saveLead(store, existing);

      return reply(200, { ok: true });
    }

    return reply(404, {
      error: "API route not found."
    });
  } catch (error) {
    return reply(500, {
      error: String(
        error.message || "Internal server error."
      )
    });
  }
};
