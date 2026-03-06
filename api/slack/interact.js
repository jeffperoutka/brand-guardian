const { waitUntil } = require('@vercel/functions');
const { slack } = require('../_lib/connectors');
const { getOrBuildBrandProfile, listInfoDocs } = require('../_lib/brand-context');
const { analyzeBrandAlignment, formatResultBlocks, CONTENT_TYPES } = require('../_lib/engine');

// Prefix for "new client" options in external_select
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
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'brand_check_submit') {
    res.status(200).json({ response_action: 'clear' });
    waitUntil(handleBrandCheck(payload));
    return;
  }

  return res.status(200).json({ response_action: 'clear' });
};

// ─────────────────────────────────────────────────────────
// Client search suggestions for external_select
// ─────────────────────────────────────────────────────────

let _infoDocsCache = null;
let _infoDocsCacheTime = 0;
const INFO_DOCS_CACHE_TTL = 60_000; // 1 min in-memory cache

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

/**
 * Build dropdown options from ClickUp Info Docs.
 * Each Info Doc becomes a selectable client.
 * Typing a name that doesn't match shows "➕ Add new client: {name}".
 */
function buildClientSuggestions(query, infoDocs) {
  const options = [];

  // Filter Info Docs by query
  const filtered = query
    ? infoDocs.filter(d => d.name.toLowerCase().includes(query))
    : infoDocs;

  // Add existing Info Doc clients as options
  for (const doc of filtered.slice(0, 90)) {
    options.push({
      text: { type: 'plain_text', text: doc.name },
      value: doc.name.toLowerCase().replace(/\s/g, '-'),
    });
  }

  // If the user typed something that doesn't exactly match an existing client,
  // show a "➕ Add new client: {name}" option
  if (query && !infoDocs.some(d => d.name.toLowerCase() === query)) {
    const displayName = titleCase(query);
    options.push({
      text: { type: 'plain_text', text: `➕ Add new client: ${displayName}` },
      value: `${NEW_CLIENT_PREFIX}${query}`,
    });
  }

  // If no query and docs exist, add a hint for new clients
  if (!query && infoDocs.length > 0) {
    options.push({
      text: { type: 'plain_text', text: '➕ Type a name to add a new client...' },
      value: '__new_hint__',
    });
  }

  // If nothing at all, tell them to type
  if (options.length === 0) {
    options.push({
      text: { type: 'plain_text', text: '📝 Type a client name...' },
      value: '__empty__',
    });
  }

  return { options };
}

// ─────────────────────────────────────────────────────────
// Brand check handler
// ─────────────────────────────────────────────────────────

/**
 * Main brand check flow — threaded conversation UX:
 *
 * 1. Post form recap as parent message (permanent receipt)
 * 2. Post progress updates as a thread reply (updated in place)
 * 3. Post final results as a separate thread reply
 * 4. User can reply in thread for dialogue / training
 */
async function handleBrandCheck(payload) {
  const values = payload.view?.state?.values;
  const userId = payload.user?.id;

  // ── Get channel from private_metadata ──
  let metadata = {};
  try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch (e) { /* ignore */ }

  // ── Parse form values ──
  let clientName = '';
  let websiteUrl = '';

  const selectedOption = values?.client_block?.client_select?.selected_option;
  if (selectedOption) {
    const val = selectedOption.value;

    if (val.startsWith(NEW_CLIENT_PREFIX)) {
      // New client from the search — extract the name they typed
      clientName = val.slice(NEW_CLIENT_PREFIX.length).replace(/-/g, ' ');
    } else if (val === '__new_hint__' || val === '__empty__') {
      // They selected the placeholder hint — no client name
      clientName = '';
    } else {
      // Existing cached brand
      clientName = val.replace(/-/g, ' ');
    }
  }

  websiteUrl = values?.client_url_block?.client_url_input?.value || '';

  const contentType = values?.type_block?.type_select?.selected_option?.value;
  let content = values?.content_block?.content_input?.value;
  const priorities = values?.priorities_block?.priorities_input?.value || '';
  const avoid = values?.avoid_block?.avoid_input?.value || '';
  const notes = values?.notes_block?.notes_input?.value;

  if (!clientName || !content || !contentType) {
    console.error('Missing required fields:', { clientName: !!clientName, content: !!content, contentType: !!contentType });
    return;
  }

  // ── Detect Google Docs/Sheets links and fetch content ──
  const googleDocMatch = content.trim().match(/docs\.google\.com\/(?:document|spreadsheets)\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  let isSheet = false;
  let sheetExtracted = false;
  if (googleDocMatch) {
    const docId = googleDocMatch[1];
    isSheet = content.includes('/spreadsheets/');
    const exportUrl = isSheet
      ? `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`
      : `https://docs.google.com/document/d/${docId}/export?format=txt`;

    try {
      console.log(`Fetching Google ${isSheet ? 'Sheet' : 'Doc'}: ${docId}`);
      const gdResp = await fetch(exportUrl, { redirect: 'follow' });
      if (gdResp.ok) {
        const gdContent = await gdResp.text();
        if (gdContent.length > 50) {
          if (isSheet) {
            // Smart extraction: parse CSV and return structured per-row data
            const { extractSheetContent } = require('../_lib/utils/sheets-extractor');
            const extraction = await extractSheetContent(gdContent, contentType, content.trim());

            if (extraction.fallback) {
              content = `[Fetched from Google Sheet (raw CSV): ${content.trim()}]\n\n${gdContent.slice(0, 50000)}`;
              console.log(`Sheet extraction fell back: ${extraction.summary}`);
            } else {
              sheetExtracted = true;
              // Build structured content for per-row analysis
              const rowTexts = extraction.rows.map((r, i) => {
                const metaLine = Object.entries(r.meta || {})
                  .filter(([k, v]) => v)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' | ');
                return `--- ROW ${r.rowNum} ---${metaLine ? `\n[${metaLine}]` : ''}\n${r.content}`;
              }).join('\n\n');
              content = `[Extracted from Google Sheet: ${content.trim()}]\n[${extraction.summary}]\n[IMPORTANT: Analyze EACH row individually. Call out specific issues per row.]\n\n${rowTexts}`;
              console.log(`Sheet content extracted: ${extraction.rows.length} rows, ${rowTexts.length} chars`);
            }
          } else {
            // Google Doc: fetch as plain text (existing behavior)
            content = `[Fetched from Google Doc: ${content.trim()}]\n\n${gdContent.slice(0, 50000)}`;
            console.log(`Google doc fetched: ${gdContent.length} chars`);
          }
        } else {
          console.log('Google doc fetch returned minimal content, using original');
        }
      } else {
        console.error(`Google doc fetch failed: HTTP ${gdResp.status}`);
        content = `[Note: Could not auto-fetch Google Doc (HTTP ${gdResp.status}) — may not be publicly shared.]\n\n${content}`;
      }
    } catch (err) {
      console.error('Google doc fetch error:', err.message);
      content = `[Note: Could not auto-fetch Google Doc — ${err.message}]\n\n${content}`;
    }
  }

  // ── Build form recap (parent message) ──
  const typeLabels = {
    on_site: '🌐 On-Site Content',
    reddit_review: '💬 Reddit Review',
    guest_post: '📝 Guest Post',
    social_media: '📱 Social Media',
  };

  const contentPreview = googleDocMatch
    ? `${sheetExtracted ? 'Extracted from' : 'Fetched from'} Google ${isSheet ? 'Sheet' : 'Doc'} (${content.length.toLocaleString()} chars)`
    : `${content.slice(0, 150).replace(/\n/g, ' ')}${content.length > 150 ? '...' : ''} _(${content.length.toLocaleString()} chars)_`;

  const recapLines = [
    `🛡️ *Brand Check Submitted*`,
    ``,
    `*Client:* ${titleCase(clientName)}`,
    `*Content Type:* ${typeLabels[contentType] || contentType}`,
    `*Content:* ${contentPreview}`,
  ];
  if (priorities) recapLines.push(`*Priorities:* ${priorities.slice(0, 150)}`);
  if (avoid) recapLines.push(`*Avoid:* ${avoid.slice(0, 150)}`);
  if (notes) recapLines.push(`*Notes:* ${notes.slice(0, 150)}`);

  const recapText = recapLines.join('\n');

  // ── Post parent message (try channel → fallback to DM) ──
  let channel = metadata.channel_id || process.env.SLACK_CHANNEL_ID;
  let usingDm = false;
  let parentMsg;

  try {
    // Try joining first (for public channels)
    await slack.joinChannel(channel).catch(() => {});
    parentMsg = await slack.postMessage(channel, recapText);

    if (!parentMsg.ok) {
      throw new Error(parentMsg.error || 'postMessage failed');
    }
  } catch (err) {
    console.error(`Channel post failed (${channel}):`, err.message, '— falling back to DM');
    channel = userId;
    usingDm = true;

    try {
      parentMsg = await slack.postMessage(channel, recapText);
      if (!parentMsg.ok) throw new Error(parentMsg.error);
    } catch (dmErr) {
      console.error('DM fallback also failed:', dmErr.message);
      return;
    }
  }

  const threadTs = parentMsg.ts;

  // Helper: post in thread
  const threadPost = async (text) => {
    return slack.postMessage(channel, text, { threadTs });
  };

  try {
    // ── Notify if using DM fallback ──
    if (usingDm) {
      await threadPost(`⚠️ I couldn't post to the channel — please invite me by typing \`/invite @Brand Guardian\` in the channel. Continuing here for now.`);
    }

    // ── Progress message in thread (will be updated in place) ──
    const progressMsg = await threadPost('⏳ Starting brand check...');
    const progressTs = progressMsg.ts;

    const updateProgress = async (stepText) => {
      try {
        await slack.updateMessage(channel, progressTs, `⏳ ${stepText}`);
      } catch (err) {
        console.error('Progress update failed:', err.message);
      }
    };

    // ── PHASE 1: Get or build brand profile ──
    await updateProgress('Loading brand profile...');

    const { profile, source, error, researchNeeded, savedToDoc } = await getOrBuildBrandProfile(
      clientName,
      websiteUrl,
      updateProgress,
      { priorities, avoid }
    );

    if (!profile) {
      await slack.updateMessage(channel, progressTs,
        `❌ ${error || 'Failed to build brand profile. Check the client name matches ClickUp.'}`
      );
      return;
    }

    if (researchNeeded) {
      const saveNote = savedToDoc !== false ? 'saved to ClickUp' : 'could not save to ClickUp';
      await updateProgress(`Deep research complete — ${saveNote}. Now analyzing content...`);
    } else if (source === 'cache') {
      await updateProgress('Brand profile loaded from cache. Analyzing content...');
    } else {
      await updateProgress('Brand profile loaded. Analyzing content...');
    }

    // ── PHASE 2: Run alignment analysis ──
    await updateProgress('Running brand alignment analysis...');

    const analysis = await analyzeBrandAlignment(content, profile, contentType, notes, { priorities, avoid });

    // ── PHASE 3: Update progress to done ──
    let doneText = '✅ Analysis complete.';
    if (researchNeeded) {
      doneText = savedToDoc !== false
        ? '✅ Complete — deep brand research was run and saved to the ClickUp Info Doc.'
        : '✅ Complete — deep brand research was run. ⚠️ Could not save to ClickUp Info Doc (check API token/permissions).';
    }
    await slack.updateMessage(channel, progressTs, doneText);

    // ── PHASE 4: Post results as separate thread reply ──
    const resultBlocks = formatResultBlocks(analysis, titleCase(clientName), contentType);

    const alignEmoji = analysis.overallAlignment === 'ALIGNED' ? '✅'
      : analysis.overallAlignment === 'PARTIALLY_ALIGNED' ? '⚠️' : '❌';
    const fallback = `${alignEmoji} Brand Check: ${analysis.overallAlignment} for ${titleCase(clientName)} — ${analysis.summary}`;

    try {
      await slack.postMessage(channel, fallback, { threadTs, blocks: resultBlocks });
    } catch (resultErr) {
      console.error('Result post failed:', resultErr.message);
      // Try plain text fallback
      await threadPost(fallback);
    }

  } catch (err) {
    console.error('handleBrandCheck error:', err.message, err.stack);
    try {
      await threadPost(`❌ Brand check failed: ${err.message}`);
    } catch (e) {
      console.error('Failed to post error to thread:', e.message);
    }
  }
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
