/**
 * Brand Enrichment Engine
 *
 * Core enrichment logic. Takes client info + website data and produces
 * a comprehensive brand profile that future bots can use for alignment checking,
 * content creation, and brand-consistent output.
 *
 * This is the TEE-UP work — building the knowledge base so that later
 * alignment/content bots have everything they need.
 */

const { askClaudeLong } = require('./connectors/claude');
const { getOrBuildBrandProfile } = require('./brand-context');

/**
 * Run full brand enrichment for a client.
 * Orchestrates: ClickUp doc lookup → website crawl → Claude research → save.
 */
async function runEnrichment(clientName, websiteUrl, notes, progressCallback) {
  return getOrBuildBrandProfile(clientName, websiteUrl, progressCallback, {
    forceRefresh: true,
    enrichmentNotes: notes,
  });
}

/**
 * Format enrichment results as Slack blocks — high-level summary.
 */
function formatEnrichmentBlocks(profile, clientName) {
  const blocks = [];

  // Header
  blocks.push({ type: 'header', text: { type: 'plain_text', text: `🔬 Brand Profile: ${clientName}` } });

  // Overview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Industry:* ${profile.industry || 'Unknown'}  •  *Website:* ${profile.website || 'N/A'}\n\n${profile.brandOverview || 'No overview available.'}`,
    },
  });

  blocks.push({ type: 'divider' });

  // Target Audience
  if (profile.targetAudience) {
    const ta = profile.targetAudience;
    let text = '*🎯 Target Audience:*\n';
    if (ta.primary) text += `• *Primary:* ${ta.primary}\n`;
    if (ta.secondary) text += `• *Secondary:* ${ta.secondary}\n`;
    if (ta.demographics) text += `• *Demographics:* ${ta.demographics}\n`;
    if (ta.psychographics) text += `• *Psychographics:* ${ta.psychographics}\n`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  // Brand Voice
  if (profile.brandVoice) {
    const bv = profile.brandVoice;
    let text = '*🗣️ Brand Voice:*\n';
    if (bv.tone) text += `• *Tone:* ${bv.tone}\n`;
    if (bv.personality) text += `• *Personality:* ${bv.personality}\n`;
    if (bv.doNotSay?.length) text += `• *Do Not Say:* ${bv.doNotSay.join(', ')}\n`;
    if (bv.preferredTerms?.length) text += `• *Preferred Terms:* ${bv.preferredTerms.join(', ')}\n`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  blocks.push({ type: 'divider' });

  // Products/Services
  if (profile.coreOfferings) {
    const co = profile.coreOfferings;
    let text = '*📦 Products & Services:*\n';
    if (co.products?.length) text += co.products.map(p => `• ${p}`).join('\n') + '\n';
    if (co.valueProposition) text += `\n*Value Prop:* ${co.valueProposition}\n`;
    if (co.pricingTier) text += `*Pricing Tier:* ${co.pricingTier}\n`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  // Competitors
  if (profile.competitors?.length) {
    let text = '*⚔️ Competitive Landscape:*\n';
    for (const c of profile.competitors.slice(0, 5)) {
      if (typeof c === 'string') {
        text += `• ${c}\n`;
      } else {
        text += `• *${c.name}:* ${c.differentiator || ''}\n`;
      }
    }
    if (profile.competitiveDifferentiators) {
      text += `\n*Key Differentiators:* ${profile.competitiveDifferentiators}\n`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  blocks.push({ type: 'divider' });

  // Content Themes
  if (profile.contentThemes) {
    const ct = profile.contentThemes;
    let text = '*📝 Content Themes:*\n';
    if (ct.onBrandTopics?.length) text += `• *On-Brand:* ${ct.onBrandTopics.join(', ')}\n`;
    if (ct.adjacentTopics?.length) text += `• *Adjacent:* ${ct.adjacentTopics.join(', ')}\n`;
    if (ct.offLimitTopics?.length) text += `• *Off-Limits:* ${ct.offLimitTopics.join(', ')}\n`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  // Key Messages
  if (profile.keyMessages?.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*💬 Key Messages:*\n${profile.keyMessages.map(m => `• ${m}`).join('\n')}` },
    });
  }

  // Website Insights
  if (profile.websiteInsights) {
    const wi = profile.websiteInsights;
    let text = '*🌐 Website Insights:*\n';
    if (wi.contentStyle) text += `• *Content Style:* ${wi.contentStyle}\n`;
    if (wi.ctaPatterns) text += `• *CTA Patterns:* ${wi.ctaPatterns}\n`;
    if (wi.socialProof) text += `• *Social Proof:* ${wi.socialProof}\n`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  }

  // Footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_This brand profile is saved to ClickUp and cached for future use. Reply in this thread to ask questions or request updates._' }],
  });

  if (blocks.length > 49) blocks.length = 49;

  return blocks;
}

module.exports = { runEnrichment, formatEnrichmentBlocks };
