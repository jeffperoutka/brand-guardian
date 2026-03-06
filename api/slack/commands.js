const { waitUntil } = require('@vercel/functions');
const { slack } = require('../lib/connectors');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { command, trigger_id, text, channel_id } = req.body;

  if (command === '/brand-check') {
    // Acknowledge immediately, then open modal async
    res.status(200).send('');
    waitUntil(openBrandCheckModal(trigger_id, text, channel_id));
    return;
  }

  res.status(200).send('Unknown command');
};

async function openBrandCheckModal(triggerId, prefillClient, channelId) {
  try {
    const blocks = [];

    // ── Client selection — searchable external select ──
    // Users type to search existing brands OR type a new name and select "+ Create: {name}"
    blocks.push({
      type: 'input',
      block_id: 'client_block',
      label: { type: 'plain_text', text: 'Client' },
      element: {
        type: 'external_select',
        action_id: 'client_select',
        placeholder: { type: 'plain_text', text: 'Search or type a new client name...' },
        min_query_length: 0, // Show all brands on focus
      },
    });

    // ── Website URL (always visible, optional) ──
    blocks.push({
      type: 'input',
      block_id: 'client_url_block',
      label: { type: 'plain_text', text: 'Client Website URL' },
      optional: true,
      element: {
        type: 'url_text_input',
        action_id: 'client_url_input',
        placeholder: { type: 'plain_text', text: 'https://www.example.com (required for new clients)' },
      },
    });

    // ── Content type ──
    blocks.push({
      type: 'input',
      block_id: 'type_block',
      label: { type: 'plain_text', text: 'Content Type' },
      element: {
        type: 'static_select',
        action_id: 'type_select',
        placeholder: { type: 'plain_text', text: 'What type of content is this?' },
        options: [
          { text: { type: 'plain_text', text: '🌐 On-Site (client website)' }, value: 'on_site' },
          { text: { type: 'plain_text', text: '💬 Reddit Review (3rd party)' }, value: 'reddit_review' },
          { text: { type: 'plain_text', text: '📝 Guest Post (off-page)' }, value: 'guest_post' },
          { text: { type: 'plain_text', text: '📱 Social Media' }, value: 'social_media' },
        ],
      },
    });

    // ── Content to review ──
    blocks.push({
      type: 'input',
      block_id: 'content_block',
      label: { type: 'plain_text', text: 'Content to Review' },
      element: {
        type: 'plain_text_input',
        action_id: 'content_input',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Paste content OR a Google Docs/Sheets link...' },
      },
    });

    // ── Client priorities (optional) ──
    blocks.push({
      type: 'input',
      block_id: 'priorities_block',
      label: { type: 'plain_text', text: 'Client Priorities (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'priorities_input',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'What should the brand focus on? e.g. "Selling crypto, bitcoin trading, ethereum exchange"' },
      },
    });

    // ── Client avoid topics (optional) ──
    blocks.push({
      type: 'input',
      block_id: 'avoid_block',
      label: { type: 'plain_text', text: 'Topics to Avoid (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'avoid_input',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'What should the brand NOT talk about? e.g. "NFTs, NFT marketplace, digital collectibles"' },
      },
    });

    // ── Optional notes ──
    blocks.push({
      type: 'input',
      block_id: 'notes_block',
      label: { type: 'plain_text', text: 'Notes (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'notes_input',
        placeholder: { type: 'plain_text', text: 'Target publication, specific angle, context, etc.' },
      },
    });

    const modal = {
      type: 'modal',
      callback_id: 'brand_check_submit',
      private_metadata: JSON.stringify({ channel_id: channelId || '' }),
      title: { type: 'plain_text', text: 'Brand Check' },
      submit: { type: 'plain_text', text: 'Check Alignment' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks,
    };

    await slack.openModal(triggerId, modal);
  } catch (err) {
    console.error('openBrandCheckModal error:', err.message);
  }
}
