const { waitUntil } = require('@vercel/functions');
const { slack } = require('../lib/connectors');
const { askClaude } = require('../lib/connectors/claude');
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

    // Thread replies → dialogue + training
    if (event.thread_ts && event.thread_ts !== event.ts) {
      res.status(200).json({ ok: true });
      waitUntil(handleThreadReply(event));
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

/**
 * Handle thread replies — supports both dialogue and training.
 *
 * Flow:
 * 1. Verify it's a Brand Guardian thread
 * 2. Pull thread history for context
 * 3. Determine intent: training rule vs. dialogue (question/feedback on specific content)
 * 4. Respond accordingly
 */
async function handleThreadReply(event) {
  const { channel, text, thread_ts: threadTs, user } = event;

  // ── Verify this is a Brand Guardian thread ──
  let threadMessages = [];
  try {
    const resp = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=30`,
      { headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` } }
    );
    const data = await resp.json();
    if (!data.ok || !data.messages?.length) return;

    // Check if the parent message is from the bot
    const parent = data.messages[0];
    if (!parent.bot_id) return;

    threadMessages = data.messages;
  } catch (err) {
    console.error('Thread lookup failed:', err.message);
    return;
  }

  const lower = text.toLowerCase().trim();

  // ── Command: list rules ──
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

  // ── Command: remove rule ──
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

  // ── Build conversation context from thread ──
  const threadContext = threadMessages
    .map(m => {
      const who = m.bot_id ? 'Brand Guardian' : 'User';
      const msgText = m.text || '';
      // Truncate long messages but keep enough for context
      return `[${who}]: ${msgText.slice(0, 2000)}`;
    })
    .join('\n\n');

  // ── Use Claude to determine intent and respond ──
  try {
    const existingRules = await rules.loadRules();

    const result = await askClaude(
      `You are Brand Guardian, an AI brand alignment assistant. You're in a Slack thread where you just completed a brand check (content alignment analysis).

The user is replying in the thread. Determine what they want and respond:

1. **TRAINING RULE** — If the user is giving feedback like "don't flag X in the future", "this should be acceptable", "always check for Y" → extract a reusable rule.
2. **DIALOGUE** — If the user is asking a question, giving feedback on a specific item, asking you to revise something, or discussing the results → have a helpful conversation.
3. **REVISION REQUEST** — If the user says something like "comment #3 could be better" or "rewrite the fix for the tone issue" → provide improved suggestions.

EXISTING TRAINING RULES:
${existingRules.map((r, i) => `${i + 1}. ${r.rule} (${r.category})`).join('\n') || '(none yet)'}

Respond with JSON only:
{
  "intent": "training_rule" | "dialogue" | "revision",
  "response": "Your response to post in Slack (use Slack mrkdwn formatting: *bold*, _italic_, \`code\`)",
  "rule": { "rule": "the rule text", "category": "voice|accuracy|content_type|audience|other" } | null,
  "isDuplicate": false
}

Keep responses concise and actionable. Use Slack formatting. If it's dialogue, be helpful and reference specific parts of the analysis when relevant.`,

      `THREAD CONTEXT:\n${threadContext}\n\nLATEST USER MESSAGE:\n"${text}"`,
      { maxTokens: 1500, timeout: 30000 }
    );

    const parsed = JSON.parse(result.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim());

    // ── Save training rule if extracted ──
    if (parsed.intent === 'training_rule' && parsed.rule && !parsed.isDuplicate) {
      await rules.addRule({
        rule: parsed.rule.rule,
        category: parsed.rule.category,
        addedBy: user,
        addedAt: new Date().toISOString(),
      });
      const ruleNote = `\n\n_📝 Rule saved — will be applied to all future checks._`;
      await slack.postMessage(channel, `${parsed.response}${ruleNote}`, { threadTs });
    } else if (parsed.isDuplicate) {
      await slack.postMessage(channel, `${parsed.response}\n\n_👍 Already have a similar rule._`, { threadTs });
    } else {
      // Dialogue or revision — just post the response
      await slack.postMessage(channel, parsed.response, { threadTs });
    }

  } catch (err) {
    console.error('Thread dialogue error:', err.message);
    // Graceful fallback
    await slack.postMessage(channel, `I had trouble processing that. Could you rephrase? You can also say \`list rules\` to see saved training rules.`, { threadTs });
  }
}

async function handleMention(event) {
  const { channel, ts } = event;
  await slack.postMessage(channel,
    `*🛡️ Brand Guardian*\n\n\`/brand-check\` — Check content alignment against a client's brand\n\nFirst run for a new client does deep research (website crawl + ClickUp Info Doc) and saves findings. Future checks are instant.\n\nReply in any brand check thread to:\n• Give feedback and train me\n• Ask questions about the analysis\n• Request revised suggestions\n• Say \`list rules\` to see training rules`,
    { threadTs: ts }
  );
}
