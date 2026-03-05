const { waitUntil } = require('@vercel/functions');
const { slack, askClaude } = require('../lib/connectors');
const { rules } = require('../lib/connectors');

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

    // Thread replies → training feedback
    if (event.thread_ts && event.thread_ts !== event.ts) {
      res.status(200).json({ ok: true });
      waitUntil(handleTrainingFeedback(event));
      return;
    }

    // @mentions → help
    if (event.type === 'app_mention') {
      res.status(200).json({ ok: true });
      waitUntil(handleMention(event));
      return;
    }

    return res.status(200).json({ ok: true });
  }

  res.status(200).json({ ok: true });
};

async function handleTrainingFeedback(event) {
  const { channel, text, thread_ts: threadTs, user } = event;

  // Verify this is a bot thread
  try {
    const resp = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=1`, {
      headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    const data = await resp.json();
    if (!data.ok || !data.messages?.[0]?.bot_id) return;
  } catch (err) { return; }

  const lower = text.toLowerCase().trim();

  // List rules command
  if (lower === 'list rules') {
    const r = await rules.loadRules();
    if (r.length === 0) {
      await slack.postMessage(channel, '📋 No training rules yet. Reply with feedback to teach me.', { threadTs });
    } else {
      const list = r.map((rule, i) => `${i + 1}. ${rule.rule} _(${rule.category})_`).join('\n');
      await slack.postMessage(channel, `📋 *Training Rules (${r.length}):*\n${list}`, { threadTs });
    }
    return;
  }

  // Remove rule command
  if (lower.startsWith('remove rule ')) {
    const num = parseInt(lower.replace('remove rule ', ''));
    const r = await rules.loadRules();
    if (num > 0 && num <= r.length) {
      const removed = r.splice(num - 1, 1)[0];
      await rules.saveRules(r);
      await slack.postMessage(channel, `🗑️ Removed: "${removed.rule}"`, { threadTs });
    }
    return;
  }

  // Parse as training feedback
  try {
    const existing = await rules.loadRules();
    const result = await askClaude(
      `Parse this team feedback into a reusable rule for future brand checks.

Existing rules: ${existing.map((r, i) => `${i + 1}. ${r.rule}`).join('\n') || '(none)'}

Respond JSON only:
{"isRule": boolean, "rule": "the rule", "category": "voice|accuracy|content_type|audience|other", "ack": "short acknowledgment", "isDuplicate": boolean}

If the message is just a question or casual comment, set isRule to false.`,
      `Feedback: "${text}"`,
      { maxTokens: 300, timeout: 15000 }
    );

    const parsed = JSON.parse(result.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim());

    if (parsed.isRule && !parsed.isDuplicate) {
      await rules.addRule({ rule: parsed.rule, category: parsed.category, addedBy: user, addedAt: new Date().toISOString() });
      await slack.postMessage(channel, `✅ ${parsed.ack}\n_Rule saved — applied to all future checks._`, { threadTs });
    } else if (parsed.isDuplicate) {
      await slack.postMessage(channel, `👍 Already have a similar rule.`, { threadTs });
    }
  } catch (err) {
    console.error('Training feedback error:', err.message);
  }
}

async function handleMention(event) {
  const { channel, ts } = event;
  await slack.postMessage(channel,
    `*🛡️ Brand Guardian*\n\n\`/brand-check\` — Check content alignment against a client's brand\n\nFirst run for a new client does deep research (website crawl + ClickUp Info Doc) and saves findings. Future checks are instant.\n\nReply to any check with feedback to train me.`,
    { threadTs: ts }
  );
}
