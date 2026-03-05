const { waitUntil } = require('@vercel/functions');
const { slack } = require('../lib/connectors');
const { listCachedBrands } = require('../lib/brand-context');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { command, trigger_id, text } = req.body;

  if (command === '/brand-check') {
    // Acknowledge immediately, then open modal async
    res.status(200).send('');
    waitUntil(openBrandCheckModal(trigger_id, text));
    return;
  }

  res.status(200).send('Unknown command');
};

async function openBrandCheckModal(triggerId, prefillClient) {
  try {
    // Try to get cached brands for the dropdown
    let brandOptions = [];
    try {
      const brands = await listCachedBrands();
      brandOptions = brands.map(b => ({
        text: { type: 'plain_text', text: titleCase(b) },
        value: b.replace(/\s/g, '-'),
      }));
    } catch (err) {
      console.error('Failed to load cached brands:', err.message);
    }

    const blocks = [];

    // ── Client selection ──
    if (brandOptions.length > 0) {
      blocks.push({
        type: 'input',
        block_id: 'client_block',
        label: { type: 'plain_text', text: 'Client' },
        element: {
          type: 'static_select',
          action_id: 'client_select',
          placeholder: { type: 'plain_text', text: 'Select a client' },
          options: [
            ...brandOptions,
            { text: { type: 'plain_text', text: '+ New Client' }, value: '__new__' },
          ],
        },
      });
      blocks.push({
        type: 'input',
        block_id: 'new_client_block',
        label: { type: 'plain_text', text: 'New Client Name' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'new_client_input',
          placeholder: { type: 'plain_text', text: 'Only if you selected "+ New Client" above' },
        },
      });
      blocks.push({
        type: 'input',
        block_id: 'new_url_block',
        label: { type: 'plain_text', text: 'Client Website URL (for new clients)' },
        optional: true,
        element: {
          type: 'url_text_input',
          action_id: 'new_url_input',
          placeholder: { type: 'plain_text', text: 'https://www.example.com' },
        },
      });
    } else {
      // No cached brands yet — text input
      blocks.push({
        type: 'input',
        block_id: 'client_text_block',
        label: { type: 'plain_text', text: 'Client Name' },
        element: {
          type: 'plain_text_input',
          action_id: 'client_text_input',
          placeholder: { type: 'plain_text', text: 'Exact name as it appears in ClickUp' },
          ...(prefillClient ? { initial_value: prefillClient } : {}),
        },
      });
      blocks.push({
        type: 'input',
        block_id: 'client_url_block',
        label: { type: 'plain_text', text: 'Client Website URL' },
        optional: true,
        element: {
          type: 'url_text_input',
          action_id: 'client_url_input',
          placeholder: { type: 'plain_text', text: 'https://www.example.com (optional — bot will try to find it)' },
        },
      });
    }

    // ── Content type (manual selection, no auto-detect) ──
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
        placeholder: { type: 'plain_text', text: 'Paste the article, comment, post, or content here...' },
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

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}
