const { waitUntil } = require('@vercel/functions');
const { slack } = require('../_lib/connectors');
const { askClaude } = require('../_lib/connectors/claude');

const processedEvents = new Set();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;

  // URL verification
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body.type === 'event_callback') {
    const event = body.event;

    // Dedup
    const eventId = body.event_id || `${event.ts}-${event.channel}`;
    if (processedEvents.has(eventId)) return res.status(200).json({ ok: true });
    processedEvents.add(eventId);
    setTimeout(() => processedEvents.delete(eventId), 300000);

    // Skip bots
    if (event.bot_id || event.subtype === 'bot_message') return res.status(200).json({ ok: true });

    // Thread replies — answer questions about enrichment results
    if (event.thread_ts && event.thread_ts !== event.ts) {
      res.status(200).json({ ok: true });
      waitUntil(handleThreadReply(event));
      return;
    }

    // @mentions — help
    if (event.type === 'app_mention') {
      res.status(200).json({ ok: true });
      waitUntil(handleMention(event));
      return;
    }

    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });
};

/**
 * Handle thread replies — answer questions about the enrichment results.
 */
async function handleThreadReply(event) {
  const { channel, text, thread_ts: threadTs } = event;

  // Verify this is a Brand Guardian thread
  let threadMessages = [];
  try {
    const resp = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=30`,
      { headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const data = await resp.json();
    if (!data.ok || !data.messages?.length) return;

    const parent = data.messages[0];
    if (!parent.bot_id) return;

    threadMessages = data.messages;
  } catch (err) {
    console.error('Thread lookup failed:', err.message);
    return;
  }

  // Build conversation context
  const threadContext = threadMessages
    .map(m => {
      const who = m.bot_id ? 'Brand Guardian' : 'User';
      const msgText = m.text || '';
      return `[${who}]: ${msgText.slice(0, 2000)}`;
    })
    .join('\n\n');

  try {
    const result = await askClaude(
      `You are Brand Guardian, an AI brand enrichment assistant. You just completed brand research for a client and posted the enrichment summary in this Slack thread.

The user is replying in the thread. They might be:
1. Asking a question about the brand profile
2. Requesting clarification on a specific section
3. Suggesting updates or corrections to the profile
4. Asking how to use this information for content creation

Respond helpfully and concisely. Use Slack mrkdwn formatting (*bold*, _italic_, \`code\`).
If they're suggesting a correction, acknowledge it and let them know the profile can be re-enriched with the /brand-enrich command.`,

      `THREAD CONTEXT:\n${threadContext}\n\nLATEST USER MESSAGE:\n"${text}"`,
      { maxTokens: 1500, timeout: 30000 }
    );

    await slack.postMessage(channel, result, { threadTs });
  } catch (err) {
    console.error('Thread reply error:', err.message);
    await slack.postMessage(channel, 'I had trouble processing that. Could you rephrase?', { threadTs });
  }
}

async function handleMention(event) {
  const { channel, ts } = event;
  await slack.postMessage(channel,
    `*🔬 Brand Guardian — Enrichment Bot*\n\n\`/brand-enrich\` — Run deep brand research on a client\n\nSelects a client from ClickUp Info Docs, crawls their website, analyzes their brand, and saves a comprehensive profile. This profile is then used by content bots, alignment checkers, and the team to ensure everything is on-brand.\n\nReply in any enrichment thread to ask questions about the results.`,
    { threadTs: ts }
  );
}
