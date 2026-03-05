const { waitUntil } = require('@vercel/functions');
const { slack } = require('../lib/connectors');
const { getOrBuildBrandProfile } = require('../lib/brand-context');
const { analyzeBrandAlignment, formatResultBlocks } = require('../lib/engine');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let payload;
  try {
    const raw = req.body?.payload || req.body;
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  // ── Modal Submission ──
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'brand_check_submit') {
    res.status(200).json({ response_action: 'clear' });
    waitUntil(handleBrandCheck(payload));
    return;
  }

  return res.status(200).json({ response_action: 'clear' });
};

/**
 * Main brand check flow:
 * 1. Parse form inputs
 * 2. Post progress message to channel
 * 3. Get or build brand profile (auto-research if needed)
 * 4. Run alignment analysis
 * 5. Post results as thread reply
 */
async function handleBrandCheck(payload) {
  const values = payload.view?.state?.values;
  const userId = payload.user?.id;

  // ── Get channel from private_metadata (passed from slash command) ──
  let metadata = {};
  try { metadata = JSON.parse(payload.view?.private_metadata || '{}'); } catch (e) { /* ignore */ }

  // ── Parse form values ──
  let clientName = '';
  let websiteUrl = '';

  // Check which form variant was used (dropdown vs text input)
  const selectValue = values?.client_block?.client_select?.selected_option?.value;
  if (selectValue) {
    if (selectValue === '__new__') {
      clientName = values?.new_client_block?.new_client_input?.value || '';
      websiteUrl = values?.new_url_block?.new_url_input?.value || '';
    } else {
      clientName = selectValue.replace(/-/g, ' ');
    }
  } else {
    clientName = values?.client_text_block?.client_text_input?.value || '';
    websiteUrl = values?.client_url_block?.client_url_input?.value || '';
  }

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
  const googleDocMatch = content.trim().match(/docs\.google\.com\/(?:document|spreadsheets)\/d\/([a-zA-Z0-9_-]+)/);
  if (googleDocMatch) {
    const docId = googleDocMatch[1];
    const isSheet = content.includes('/spreadsheets/');
    const exportUrl = isSheet
      ? `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv`
      : `https://docs.google.com/document/d/${docId}/export?format=txt`;

    try {
      console.log(`Fetching Google ${isSheet ? 'Sheet' : 'Doc'}: ${docId}`);
      const gdResp = await fetch(exportUrl, { redirect: 'follow' });
      if (gdResp.ok) {
        const gdContent = await gdResp.text();
        if (gdContent.length > 50) {
          content = `[Fetched from Google ${isSheet ? 'Sheet' : 'Doc'}: ${content.trim()}]\n\n${gdContent.slice(0, 50000)}`;
          console.log(`Google doc fetched: ${gdContent.length} chars`);
        } else {
          console.log('Google doc fetch returned minimal content, using original');
        }
      } else {
        console.error(`Google doc fetch failed: HTTP ${gdResp.status}`);
        content = `[Note: Could not auto-fetch Google Doc (HTTP ${gdResp.status}) — the document may not be publicly shared. Using link as-is.]\n\n${content}`;
      }
    } catch (err) {
      console.error('Google doc fetch error:', err.message);
      content = `[Note: Could not auto-fetch Google Doc — ${err.message}. Using link as-is.]\n\n${content}`;
    }
  }

  const channel = metadata.channel_id || process.env.SLACK_CHANNEL_ID || userId;
  console.log('Posting to channel:', channel, '(source:', metadata.channel_id ? 'metadata' : process.env.SLACK_CHANNEL_ID ? 'env' : 'userId', ')');

  // ── Google Doc fetch note for progress ──
  const hasGoogleDoc = !!googleDocMatch;

  try {
    // ── Post initial progress message ──
    await slack.joinChannel(channel).catch(() => {});
    const priorityNote = priorities || avoid
      ? `\n📌 ${priorities ? `Focus: _${priorities.slice(0, 80)}_` : ''}${avoid ? `${priorities ? ' | ' : ''}Avoid: _${avoid.slice(0, 80)}_` : ''}`
      : '';
    const googleNote = hasGoogleDoc ? '\n📄 Content fetched from Google Doc/Sheet' : '';
    const msg = await slack.postMessage(channel, `🛡️ *Brand Check* for *${titleCase(clientName)}*${priorityNote}${googleNote}\n⏳ Starting...`);
    const msgTs = msg.ts;

    // ── Progress callback — updates the message in real time ──
    const updateProgress = async (stepText) => {
      try {
        await slack.updateMessage(channel, msgTs, `🛡️ *Brand Check* for *${titleCase(clientName)}*\n⏳ ${stepText}`, [
          { type: 'section', text: { type: 'mrkdwn', text: `🛡️ *Brand Check* for *${titleCase(clientName)}*\n⏳ ${stepText}` } },
        ]);
      } catch (err) {
        console.error('Progress update failed:', err.message);
      }
    };

    // ── PHASE 1: Get or build brand profile ──
    await updateProgress('Loading brand profile...');

    const { profile, source, error, researchNeeded } = await getOrBuildBrandProfile(
      clientName,
      websiteUrl,
      updateProgress,
      { priorities, avoid }
    );

    if (!profile) {
      await slack.updateMessage(channel, msgTs,
        `🛡️ *Brand Check* for *${titleCase(clientName)}*\n❌ ${error || 'Failed to build brand profile.'}`,
        [{
          type: 'section',
          text: { type: 'mrkdwn', text: `🛡️ *Brand Check* for *${titleCase(clientName)}*\n❌ ${error || 'Failed to build brand profile. Check the client name matches ClickUp.'}` },
        }]
      );
      return;
    }

    // Log what happened with research
    if (researchNeeded) {
      await updateProgress('Deep research complete. Research written back to ClickUp. Now analyzing content...');
    } else if (source === 'cache') {
      await updateProgress('Brand profile loaded from cache. Analyzing content...');
    } else {
      await updateProgress('Brand profile loaded. Analyzing content...');
    }

    // ── PHASE 2: Run alignment analysis ──
    await updateProgress('Running brand alignment analysis...');

    const analysis = await analyzeBrandAlignment(content, profile, contentType, notes, { priorities, avoid });

    // ── PHASE 3: Post results ──
    const resultBlocks = formatResultBlocks(analysis, titleCase(clientName), contentType);

    const alignEmoji = analysis.overallAlignment === 'ALIGNED' ? '✅'
      : analysis.overallAlignment === 'PARTIALLY_ALIGNED' ? '⚠️' : '❌';
    const fallback = `${alignEmoji} Brand Check: ${analysis.overallAlignment} for ${titleCase(clientName)} — ${analysis.summary}`;

    // Add research note if first time
    if (researchNeeded) {
      resultBlocks.unshift({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '📝 _First check for this client — deep brand research was run and saved to the ClickUp Info Doc._' }],
      });
    }

    try {
      await slack.updateMessage(channel, msgTs, fallback, resultBlocks);
    } catch (updateErr) {
      console.error('Update failed, posting new message:', updateErr.message);
      await slack.postMessage(channel, fallback, { blocks: resultBlocks, threadTs: msgTs });
    }

  } catch (err) {
    console.error('handleBrandCheck error:', err.message, err.stack);
    try {
      await slack.postMessage(channel, `❌ Brand check failed for ${titleCase(clientName)}: ${err.message}`);
    } catch (e) {
      console.error('Failed to post error:', e.message);
    }
  }
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
