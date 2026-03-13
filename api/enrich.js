/**
 * Standalone enrichment endpoint.
 *
 * Called by the typeform-webhook after creating the Google Drive folder + doc.
 * Runs website crawl + Claude analysis + appends results to the doc.
 * Separated so each step gets its own 60s Vercel Hobby execution window.
 *
 * POST /api/enrich
 * Body: { clientName, websiteUrl, competitors, docId, folderId, docContent }
 */

const gdrive = require('./_lib/connectors/gdrive');
const github = require('./_lib/connectors/github');
const { runDeepResearch } = require('./_lib/brand-context');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { clientName, websiteUrl, competitors, docId, folderId, docContent } = req.body || {};

  if (!clientName || !docId) {
    return res.status(400).json({ error: 'Missing clientName or docId' });
  }

  console.log(`[enrich] Starting enrichment for ${clientName} (doc: ${docId})`);

  try {
    const research = await runDeepResearch(
      clientName,
      docContent || '',
      websiteUrl,
      (msg) => console.log(`[enrich] ${msg}`),
      { enrichmentNotes: competitors ? `Key competitors: ${competitors}` : '' }
    );

    if (!research || research._parseError) {
      console.error(`[enrich] Brand enrichment failed for ${clientName}:`, research?._parseError || 'null result');
      await gdrive.appendToDoc(docId, '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n⚠️ Brand enrichment could not be completed. Please run /brand-enrich in Slack to retry.');
      return res.status(200).json({
        ok: true,
        enriched: false,
        reason: research?._parseError || 'research returned null',
        rawPreview: research?._rawPreview || null,
      });
    }

    // Append enrichment results to the doc
    const researchText = formatResearchForDoc(clientName, research);
    await gdrive.appendToDoc(docId, researchText);
    console.log(`[enrich] Enrichment results appended to doc`);

    // Cache the profile in GitHub
    const cacheKey = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const profileWithMeta = {
      ...research,
      clientName,
      cachedAt: new Date().toISOString(),
      cacheKey,
      googleDocId: docId,
      googleFolderId: folderId,
    };
    await github.writeFile(`brand-cache/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);

    console.log(`[enrich] ✅ Complete: ${clientName}`);
    return res.status(200).json({ ok: true, enriched: true, clientName });
  } catch (err) {
    console.error(`[enrich] ❌ Failed for ${clientName}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Format enrichment research results as text for appending to Google Doc.
 */
function formatResearchForDoc(clientName, research) {
  let text = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  text += '🛡️ BRAND GUARDIAN RESEARCH\n\n';
  text += `Auto-generated on ${new Date().toISOString().split('T')[0]} — updated by Brand Guardian\n`;
  text += 'This section is used for brand alignment checks, content creation, and brand-consistent output.\n\n';
  text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  if (research.brandOverview) {
    text += `BRAND OVERVIEW\n${research.brandOverview}\n\n`;
  }

  if (research.targetAudience) {
    text += 'TARGET AUDIENCE\n';
    const ta = research.targetAudience;
    if (ta.primary) text += `Primary: ${ta.primary}\n`;
    if (ta.secondary) text += `Secondary: ${ta.secondary}\n`;
    if (ta.demographics) text += `Demographics: ${ta.demographics}\n`;
    if (ta.psychographics) text += `Psychographics: ${ta.psychographics}\n`;
    text += '\n';
  }

  if (research.brandVoice) {
    text += 'BRAND VOICE & TONE\n';
    const bv = research.brandVoice;
    if (bv.tone) text += `Tone: ${bv.tone}\n`;
    if (bv.personality) text += `Personality: ${bv.personality}\n`;
    if (bv.doNotSay && bv.doNotSay.length) text += `Do Not Say: ${bv.doNotSay.join(', ')}\n`;
    if (bv.preferredTerms && bv.preferredTerms.length) text += `Preferred Terms: ${bv.preferredTerms.join(', ')}\n`;
    text += '\n';
  }

  if (research.coreOfferings) {
    text += 'PRODUCTS & SERVICES\n';
    const co = research.coreOfferings;
    if (co.products && co.products.length) {
      co.products.forEach(p => { text += `• ${p}\n`; });
    }
    if (co.valueProposition) text += `\nValue Proposition: ${co.valueProposition}\n`;
    if (co.keyBenefits && co.keyBenefits.length) text += `Key Benefits: ${co.keyBenefits.join(', ')}\n`;
    if (co.pricingTier) text += `Pricing Tier: ${co.pricingTier}\n`;
    text += '\n';
  }

  if (research.competitors && research.competitors.length) {
    text += 'COMPETITIVE LANDSCAPE\n';
    research.competitors.forEach(c => {
      text += `• ${c.name}: ${c.differentiator}\n`;
    });
    if (research.competitiveDifferentiators) {
      text += `\nKey Differentiators: ${research.competitiveDifferentiators}\n`;
    }
    text += '\n';
  }

  if (research.contentThemes) {
    text += 'CONTENT THEMES\n';
    const ct = research.contentThemes;
    if (ct.onBrandTopics && ct.onBrandTopics.length) text += `On-Brand Topics: ${ct.onBrandTopics.join(', ')}\n`;
    if (ct.adjacentTopics && ct.adjacentTopics.length) text += `Adjacent Topics (guest posts): ${ct.adjacentTopics.join(', ')}\n`;
    if (ct.offLimitTopics && ct.offLimitTopics.length) text += `Off-Limit Topics: ${ct.offLimitTopics.join(', ')}\n`;
    text += '\n';
  }

  if (research.keyMessages && research.keyMessages.length) {
    text += 'KEY MESSAGES\n';
    research.keyMessages.forEach(m => { text += `• ${m}\n`; });
    text += '\n';
  }

  if (research.websiteInsights) {
    text += 'WEBSITE INSIGHTS\n';
    const wi = research.websiteInsights;
    if (wi.contentStyle) text += `Content Style: ${wi.contentStyle}\n`;
    if (wi.ctaPatterns) text += `CTA Patterns: ${wi.ctaPatterns}\n`;
    if (wi.socialProof) text += `Social Proof: ${wi.socialProof}\n`;
    if (wi.mainPages && wi.mainPages.length) text += `Pages Analyzed: ${wi.mainPages.join(', ')}\n`;
    text += '\n';
  }

  if (research.industryContext) {
    text += `INDUSTRY CONTEXT\n${research.industryContext}\n\n`;
  }

  return text;
}
