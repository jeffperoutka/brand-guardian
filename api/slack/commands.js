const { waitUntil } = require('@vercel/functions');
const { slack } = require('../_lib/connectors');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { command, trigger_id, channel_id } = req.body;

  if (command === '/brand-enrich') {
    res.status(200).send('');
    waitUntil(openEnrichModal(trigger_id, channel_id));
    return;
  }

  res.status(200).send('Unknown command');
};

async function openEnrichModal(triggerId, channelId) {
  try {
    const blocks = [];

    // ── Client selection — searchable external select ──
    blocks.push({
      type: 'input',
      block_id: 'client_block',
      label: { type: 'plain_text', text: 'Client' },
      element: {
        type: 'external_select',
        action_id: 'client_select',
        placeholder: { type: 'plain_text', text: 'Search or type a new client name...' },
        min_query_length: 0,
      },
    });

    // ── Website URL (required for new clients) ──
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

    // ── Optional notes for enrichment focus ──
    blocks.push({
      type: 'input',
      block_id: 'notes_block',
      label: { type: 'plain_text', text: 'Enrichment Notes (optional)' },
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'notes_input',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Any specific areas to focus research on, e.g. "focus on their competitors in the CBD space" or "they are pivoting away from NFTs"' },
      },
    });

    const modal = {
      type: 'modal',
      callback_id: 'brand_enrich_submit',
      private_metadata: JSON.stringify({ channel_id: channelId || '' }),
      title: { type: 'plain_text', text: 'Brand Enrichment' },
      submit: { type: 'plain_text', text: 'Start Enrichment' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks,
    };

    await slack.openModal(triggerId, modal);
  } catch (err) {
    console.error('openEnrichModal error:', err.message);
  }
}
