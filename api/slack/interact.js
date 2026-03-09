const { waitUntil } = require('@vercel/functions');
const { slack } = require('../_lib/connectors');
const { listInfoDocs } = require('../_lib/brand-context');
const { runEnrichment, formatEnrichmentBlocks } = require('../_lib/engine');

const NEW_CLIENT_PREFIX = '__new__:';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try {
    const raw = req.body?.payload || req.body;
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // ── External Select: search-as-you-type for client picker ──
  if (payload.type === 'block_suggestion') {
    const query = (payload.value || '').trim().toLowerCase();
    return res.status(200).json(buildClientSuggestions(query, await getInfoDocsSafe()));
  }

  // ── Modal Submission ──
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'brand_enrich_submit') {
    res.status(200).json({ response_action: 'clear' });
    waitUntil(handleEnrichment(payload));
    return;
  }

  return res.status(200).json({ response_action: 'clear' });
};

// ─────────────────────────────────────────────────────────
// Client search suggestions for external_select
// ─────────────────────────────────────────────────────────

let _infoDocsCache = null;
let _infoDocsCacheTime = 0;
const INFO_DOCS_CACHE_TTL = 60_000;

async function getInfoDocsSafe() {
  if (_infoDocsCache && Date.now() - _infoDocsCacheTime < INFO_DOCS_CACHE_TTL) {
    return _infoDocsCache;
  }
  try {
    _infoDocsCache = await listInfoDocs();
    _infoDocsCacheTime = Date.now();
    return _infoDocsCache;
  } catch (err) {
    console.error('Failed to load info docs:', err.message);
    return _infoDocsCache || [];
  }
}

function buildClientSuggestions(query, infoDocs) {
  const options = [];

  const filtered = query
    ? infoDocs.filter(d => d.name.toLowerCase().includes(query))
    : infoDocs;

  for (const doc of filtered.slice(0, 90)) {
    options.push({
      text: { type: 'plain_text', text: doc.docName },
      value: `${doc.docId}::${doc.name}`,
    });
  }

  if (query && !infoDocs.some(d => d.name.toLowerCase() === query)) {
    const displayName = titleCase(query);
    options.push({
      text: { type: 'plain_text', text: `➕ Add new client: ${displayName}` },
      value: `${NEW_CLIENT_PREFIX}${query}`,
    });
  }

  if (options.length === 0) {
    options.push({
      text: { type: 'plain_text', text: '📝 Type a client name...' },
      value: '__empty__',
    });
  }

  return { options };
}

// ─────────────────────────────────────────────────────────
// Brand enrichment handler
// ─────────────────────────────────────────────────────────

async function handleEnrichment(payload) {
  const values = payload.view?.state?.values;
  const userId = payload.user?.id;

  let metadata = {};
  try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch (e) { /* ignore */ }

  // ── Parse form values ──
  let clientName = '';
  let websiteUrl = '';
  let docId = null;

  const selectedOption = values?.client_block?.client_select?.selected_option;
  console.log('[handleEnrichment] Raw selected option:', JSON.stringify(selectedOption));
  if (selectedOption) {
    const val = selectedOption.value;
    console.log(`[handleEnrichment] Parsing value: "${val}"`);
    if (val.startsWith(NEW_CLIENT_PREFIX)) {
      clientName = val.slice(NEW_CLIENT_PREFIX.length).replace(/-/g, ' ');
    } else if (val === '__new_hint__' || val === '__empty__') {
      clientName = '';
    } else if (val.includes('::')) {
      // Format: "docId::ExactClientName" — from known Info Docs
      const sepIdx = val.indexOf('::');
      docId = val.substring(0, sepIdx);
      clientName = val.substring(sepIdx + 2);
      console.log(`[handleEnrichment] Parsed docId="${docId}", clientName="${clientName}"`);
    } else {
      clientName = val.replace(/-/g, ' ');
      console.log(`[handleEnrichment] Legacy value (no docId): clientName="${clientName}"`);
    }
  }

  websiteUrl = values?.client_url_block?.client_url_input?.value || '';
  const notes = values?.notes_block?.notes_input?.value || '';

  if (!clientName) {
    console.error('Missing client name');
    return;
  }

  // ── Post acknowledgment (Step 1: notify task started) ──
  let channel = metadata.channel_id || process.env.SLACK_CHANNEL_ID;
  let usingDm = false;
  let parentMsg;

  const startText = `🔬 *Brand Enrichment Started*\n\n*Client:* ${titleCase(clientName)}${websiteUrl ? `\n*Website:* ${websiteUrl}` : ''}${notes ? `\n*Focus:* ${notes.slice(0, 200)}` : ''}\n\n_Kicked off by <@${userId}>_`;

  try {
    await slack.joinChannel(channel).catch(() => {});
    parentMsg = await slack.postMessage(channel, startText);
    if (!parentMsg.ok) throw new Error(parentMsg.error || 'postMessage failed');
  } catch (err) {
    console.error(`Channel post failed (${channel}):`, err.message, '— falling back to DM');
    channel = userId;
    usingDm = true;
    try {
      parentMsg = await slack.postMessage(channel, startText);
      if (!parentMsg.ok) throw new Error(parentMsg.error);
    } catch (dmErr) {
      console.error('DM fallback also failed:', dmErr.message);
      return;
    }
  }

  const threadTs = parentMsg.ts;
  const threadPost = async (text) => slack.postMessage(channel, text, { threadTs });

  try {
    if (usingDm) {
      await threadPost('⚠️ I couldn\'t post to the channel — please invite me by typing `/invite @Brand Guardian` in the channel.');
    }

    // ── Progress message ──
    const progressMsg = await threadPost('⏳ Starting brand enrichment...');
    const progressTs = progressMsg.ts;

    const updateProgress = async (stepText) => {
      try {
        await slack.updateMessage(channel, progressTs, `⏳ ${stepText}`);
      } catch (err) {
        console.error('Progress update failed:', err.message);
      }
    };

    // ── Run enrichment (deep research + profile building) ──
    const result = await runEnrichment(clientName, websiteUrl, notes, updateProgress, { docId });

    if (!result.profile) {
      await slack.updateMessage(channel, progressTs,
        `❌ ${result.error || 'Enrichment failed. Check the client name or provide a website URL.'}`
      );
      return;
    }

    // ── Update progress to done ──
    let doneText = '✅ Enrichment complete.';
    if (result.savedToDoc) {
      doneText = '✅ Enrichment complete — research saved to Google Doc.';
    } else if (result.savedToDoc === false) {
      doneText = '✅ Enrichment complete — ⚠️ could not save to Google Doc (cached in GitHub).';
    }
    await slack.updateMessage(channel, progressTs, doneText);

    // ── Post enrichment summary (Step 2+3: completion + high-level notes) ──
    const summaryBlocks = formatEnrichmentBlocks(result.profile, titleCase(clientName));
    const fallback = `✅ Brand Enrichment Complete: ${titleCase(clientName)} — ${result.profile.brandOverview?.slice(0, 200) || 'Profile built successfully.'}`;

    try {
      await slack.postMessage(channel, fallback, { threadTs, blocks: summaryBlocks });
    } catch (resultErr) {
      console.error('Result post failed:', resultErr.message);
      await threadPost(fallback);
    }

  } catch (err) {
    console.error('handleEnrichment error:', err.message, err.stack);
    try {
      await threadPost(`❌ Enrichment failed: ${err.message}`);
    } catch (e) {
      console.error('Failed to post error to thread:', e.message);
    }
  }
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
