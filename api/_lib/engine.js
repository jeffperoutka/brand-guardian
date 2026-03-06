/**
 * Brand Guardian Engine v2
 *
 * Core alignment analysis. No auto-detect — user always selects content type.
 *
 * Content Types:
 * - on_site: Content going on the client's website (strictest)
 * - reddit_review: Third-party Reddit review/discussion
 * - guest_post: Off-page guest post content
 * - social_media: Social media content
 */

const { askClaudeLong } = require('./connectors/claude');
const { getRulesForPrompt } = require('./connectors/rules');

const CONTENT_TYPES = {
  on_site: {
    label: '🌐 On-Site Content',
    name: 'On-Site Content (Client Website)',
    standard: 'STRICT — Must perfectly match brand voice, audience, and offerings. Every claim must be accurate. Tone must match their existing site content. Should read as if the client wrote it themselves.',
    checks: [
      'Brand voice and tone match the client\'s actual writing style',
      'Target audience alignment — is this written FOR their audience?',
      'Product/service descriptions are factually accurate',
      'Messaging aligns with their key messages and value proposition',
      'CTAs match their conversion patterns',
      'Uses their preferred terminology (not competitor language)',
      'No accidental competitor mentions',
      'Topic is one the brand would actually publish about',
      'Technical accuracy for their industry',
    ],
  },
  reddit_review: {
    label: '💬 Reddit Review',
    name: 'Reddit Review / Third-Party Discussion',
    standard: 'MODERATE — Must sound authentically third-party, NOT like marketing copy. Product mentions must be accurate but casual. Should read like a real person recommending something they\'ve actually used.',
    checks: [
      'Sounds like a real person, not a marketer (no brand-speak)',
      'Product/brand mentions are factually accurate',
      'Benefits mentioned are real benefits the brand actually offers',
      'Use case described matches the brand\'s actual target audience',
      'Language is natural Reddit-style (casual, conversational)',
      'Recommendation feels genuine, not forced or over-the-top',
      'Subreddit/context is appropriate for the brand\'s niche',
      'Doesn\'t read like a paid testimonial',
      'Any specific claims or features mentioned actually exist',
    ],
  },
  guest_post: {
    label: '📝 Guest Post',
    name: 'Guest Post / Off-Page Content',
    standard: 'FLEXIBLE — The article topic can be loosely related to the brand\'s industry. However, the section mentioning the client MUST be accurate, relevant, and naturally integrated. The brand mention should make contextual sense.',
    checks: [
      'Overall topic is at least adjacent to the brand\'s industry',
      'Brand mention section is factually accurate about products/services',
      'Brand mention is naturally woven in — not forced or random',
      'Brand description matches their actual positioning',
      'Any link anchor text is appropriate and natural',
      'Article quality is sufficient for a legit publication',
      'No claims that contradict the brand\'s positioning',
      'There\'s logical audience overlap between article topic and brand',
      'The context around the brand mention makes the mention relevant',
    ],
  },
  social_media: {
    label: '📱 Social Media',
    name: 'Social Media Content',
    standard: 'MODERATE-STRICT — Should reflect brand personality in a casual format. Must be accurate but can be more playful/engaging than on-site content. Platform-appropriate.',
    checks: [
      'Brand voice adapted for social context (can be more casual)',
      'Messaging aligns with brand values and positioning',
      'Claims and statistics are accurate',
      'CTAs appropriate for social (engagement vs. hard sell)',
      'Hashtags and mentions are relevant',
      'Doesn\'t accidentally promote competitors',
      'Tone matches the brand personality',
    ],
  },
};

/**
 * Run brand alignment analysis
 */
async function analyzeBrandAlignment(content, brandProfile, contentType, additionalNotes, directives = {}) {
  const typeConfig = CONTENT_TYPES[contentType];
  if (!typeConfig) throw new Error(`Unknown content type: ${contentType}`);

  const trainingRules = await getRulesForPrompt();

  const systemPrompt = `You are a Brand Alignment Specialist at AEO Labs (AI SEO agency). You review content created by the team and determine whether it aligns with the client's brand — their voice, audience, offerings, and positioning.

You are reviewing: **${typeConfig.name}**

ALIGNMENT STANDARD:
${typeConfig.standard}

CHECKS TO PERFORM:
${typeConfig.checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

CLIENT BRAND PROFILE:
━━━━━━━━━━━━━━━━━━━━
Client: ${brandProfile.clientName || 'Unknown'}
Industry: ${brandProfile.industry || 'Unknown'}
Website: ${brandProfile.website || 'Unknown'}

OVERVIEW: ${brandProfile.brandOverview || 'N/A'}

TARGET AUDIENCE:
• Primary: ${brandProfile.targetAudience?.primary || 'Unknown'}
• Secondary: ${brandProfile.targetAudience?.secondary || 'N/A'}
• Demographics: ${brandProfile.targetAudience?.demographics || 'Unknown'}
• Psychographics: ${brandProfile.targetAudience?.psychographics || 'Unknown'}

BRAND VOICE:
• Tone: ${brandProfile.brandVoice?.tone || 'Unknown'}
• Personality: ${brandProfile.brandVoice?.personality || 'Unknown'}
• Do Not Say: ${(brandProfile.brandVoice?.doNotSay || []).join('; ') || 'None specified'}
• Preferred Terms: ${(brandProfile.brandVoice?.preferredTerms || []).join('; ') || 'None specified'}

PRODUCTS/SERVICES:
${(brandProfile.coreOfferings?.products || ['Unknown']).map(p => `• ${p}`).join('\n')}
• Value Prop: ${brandProfile.coreOfferings?.valueProposition || 'Unknown'}
• Key Benefits: ${(brandProfile.coreOfferings?.keyBenefits || []).join('; ') || 'Unknown'}
• Pricing Tier: ${brandProfile.coreOfferings?.pricingTier || 'Unknown'}

COMPETITIVE LANDSCAPE:
${(brandProfile.competitors || []).map(c => typeof c === 'string' ? `• ${c}` : `• ${c.name}: ${c.differentiator || ''}`).join('\n') || '• None listed'}
Differentiators: ${brandProfile.competitiveDifferentiators || 'N/A'}

CONTENT THEMES:
• On-Brand: ${(brandProfile.contentThemes?.onBrandTopics || []).join(', ') || 'Unknown'}
• Adjacent (guest posts OK): ${(brandProfile.contentThemes?.adjacentTopics || []).join(', ') || 'Unknown'}
• Off-Limits: ${(brandProfile.contentThemes?.offLimitTopics || []).join(', ') || 'None'}

KEY MESSAGES: ${(brandProfile.keyMessages || []).join(' | ') || 'Unknown'}

WEBSITE STYLE:
• Content Style: ${brandProfile.websiteInsights?.contentStyle || 'Unknown'}
• CTA Patterns: ${brandProfile.websiteInsights?.ctaPatterns || 'Unknown'}
━━━━━━━━━━━━━━━━━━━━
${trainingRules}
${directives.priorities || directives.avoid ? `
━━━ CLIENT DIRECTIVES ━━━
${directives.priorities ? `🎯 PRIORITY TOPICS (content SHOULD focus on): ${directives.priorities}` : ''}
${directives.avoid ? `🚫 AVOID TOPICS (content must NOT mention): ${directives.avoid}` : ''}
━━━━━━━━━━━━━━━━━━━━
CRITICAL: These directives are the client's explicit instructions and take HIGHEST PRIORITY in your analysis.
- If the content mentions AVOIDED topics, flag each one as a HIGH severity misalignment — even if the brand profile suggests those topics are relevant.
- If the content does NOT cover PRIORITY topics when it should, flag this as a misalignment.
- Content that focuses on priority topics and avoids excluded topics should receive higher alignment scores.
` : ''}
OUTPUT — respond with valid JSON only, no markdown fences:
{
  "overallAlignment": "ALIGNED | PARTIALLY_ALIGNED | NOT_ALIGNED",
  "confidenceScore": 85,
  "summary": "2-3 sentence executive summary. Be direct — what's the verdict and why.",
  "alignedElements": [
    {
      "element": "What's working",
      "why": "Why this is on-brand",
      "quote": "Short quote from the content"
    }
  ],
  "misalignedElements": [
    {
      "element": "What's off",
      "severity": "HIGH | MEDIUM | LOW",
      "why": "Why this doesn't match the brand",
      "quote": "Short quote showing the issue",
      "fix": "Specific, actionable fix — not vague advice"
    }
  ],
  "voiceCheck": {
    "toneMatch": true/false,
    "terminologyMatch": true/false,
    "audienceMatch": true/false,
    "note": "Brief voice assessment"
  },
  "flaggedClaims": ["Any product claims, stats, or features that seem inaccurate or unverifiable"],
  "topFixes": ["Top 3 most impactful changes to improve alignment, in priority order"],
  "rowAnalysis": [
    {
      "row": 2,
      "status": "ALIGNED | NEEDS_WORK | NOT_ALIGNED",
      "summary": "One sentence verdict for this specific row",
      "issues": ["Specific issue with fix suggestion"],
      "quote": "Key excerpt from this row's content"
    }
  ]
}

IMPORTANT — ROW-LEVEL ANALYSIS:
If the content contains "--- ROW X ---" markers, it came from a Google Sheet. You MUST:
1. Analyze EACH row individually and populate the "rowAnalysis" array.
2. Reference the specific row number in your aligned/misaligned elements.
3. Quote specific text from individual rows, not generic observations.
4. Mention any metadata (URLs, subreddit, status) from each row that's relevant.
5. If a row's content has links, acknowledge them and assess whether they're appropriate.
If there are no row markers, omit the rowAnalysis field entirely.

RULES:
1. Be useful, not nitpicky. Only flag things that genuinely affect brand alignment.
2. For guest posts: focus your analysis on the brand mention section. The rest of the article just needs to be topically adjacent.
3. For Reddit reviews: authenticity matters more than perfect messaging. Flag it if it sounds like marketing copy.
4. Every misaligned element MUST have a specific, actionable fix. "Adjust the tone" is not good enough.
5. Include actual quotes from the content to support your assessment.
6. If it's mostly good with minor tweaks → PARTIALLY_ALIGNED.
7. Only use NOT_ALIGNED if the content fundamentally misrepresents the brand or is way off-target.`;

  const userContent = `Analyze this ${typeConfig.name.toLowerCase()} for brand alignment with ${brandProfile.clientName || 'the client'}.

${additionalNotes ? `SUBMITTER NOTES: ${additionalNotes}\n` : ''}
CONTENT:
───────
${content.slice(0, 15000)}
───────`;

  const result = await askClaudeLong(systemPrompt, userContent, { maxTokens: 6000, timeout: 120000 });

  try {
    const cleaned = result.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Parse alignment result failed:', err.message);
    console.error('Raw result (first 500 chars):', result.slice(0, 500));
    console.error('Raw result (last 500 chars):', result.slice(-500));

    // Try to extract JSON from the response (Claude sometimes adds preamble)
    const jsonMatch = result.match(/\{[\s\S]*"overallAlignment"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.error('Secondary parse also failed:', e.message);
      }
    }

    // Last resort: return a readable error with whatever Claude said
    const summaryMatch = result.match(/"summary"\s*:\s*"([^"]+)"/);
    return {
      overallAlignment: 'ERROR',
      summary: summaryMatch?.[1] || `Analysis completed but output was malformed. Raw response length: ${result.length} chars. This usually means the input was too large or complex.`,
    };
  }
}

/**
 * Format results as Slack blocks
 */
function formatResultBlocks(analysis, clientName, contentType) {
  const typeConfig = CONTENT_TYPES[contentType] || { name: 'Content' };

  const emoji = { ALIGNED: '✅', PARTIALLY_ALIGNED: '⚠️', NOT_ALIGNED: '❌', ERROR: '🔴' };
  const label = { ALIGNED: 'Aligned', PARTIALLY_ALIGNED: 'Partially Aligned', NOT_ALIGNED: 'Not Aligned', ERROR: 'Error' };

  const e = emoji[analysis.overallAlignment] || '❓';
  const l = label[analysis.overallAlignment] || 'Unknown';

  const blocks = [];

  // Header
  blocks.push({ type: 'header', text: { type: 'plain_text', text: `${e} Brand Alignment: ${l}` } });

  // Meta + Summary
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Client:* ${clientName}  •  *Type:* ${typeConfig.name}  •  *Score:* ${analysis.confidenceScore || '—'}%\n\n${analysis.summary}`,
    },
  });

  blocks.push({ type: 'divider' });

  // ✅ Aligned
  if (analysis.alignedElements?.length > 0) {
    let alignedText = '*✅ What\'s On-Brand:*\n';
    for (const item of analysis.alignedElements.slice(0, 4)) {
      alignedText += `\n• *${item.element}* — ${item.why}`;
      if (item.quote) alignedText += `\n  _"${item.quote.slice(0, 120)}"_`;
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: alignedText } });
  }

  // ❌ Misaligned
  if (analysis.misalignedElements?.length > 0) {
    blocks.push({ type: 'divider' });
    let misText = '*❌ What Needs Work:*\n';
    for (const item of analysis.misalignedElements.slice(0, 5)) {
      const sev = item.severity === 'HIGH' ? '🔴' : item.severity === 'MEDIUM' ? '🟡' : '🟢';
      misText += `\n${sev} *${item.element}* _(${item.severity})_\n${item.why}`;
      if (item.quote) misText += `\n_"${item.quote.slice(0, 120)}"_`;
      if (item.fix) misText += `\n💡 *Fix:* ${item.fix}`;
      misText += '\n';
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: misText } });
  }

  // Voice Check
  if (analysis.voiceCheck) {
    blocks.push({ type: 'divider' });
    const vc = analysis.voiceCheck;
    const checks = `Tone ${vc.toneMatch ? '✅' : '❌'}  •  Terminology ${vc.terminologyMatch ? '✅' : '❌'}  •  Audience ${vc.audienceMatch ? '✅' : '❌'}`;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🎯 Voice Check:* ${checks}${vc.note ? `\n${vc.note}` : ''}` },
    });
  }

  // Flagged Claims
  if (analysis.flaggedClaims?.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*⚠️ Flagged Claims:*\n${analysis.flaggedClaims.map(c => `• ${c}`).join('\n')}` },
    });
  }

  // Row-Level Analysis (for spreadsheet content)
  if (analysis.rowAnalysis?.length > 0) {
    blocks.push({ type: 'divider' });
    const statusEmoji = { ALIGNED: '✅', NEEDS_WORK: '⚠️', NOT_ALIGNED: '❌' };
    let rowText = '*📊 Row-by-Row Analysis:*\n';
    for (const row of analysis.rowAnalysis.slice(0, 10)) {
      const re = statusEmoji[row.status] || '❓';
      rowText += `\n${re} *Row ${row.row}:* ${row.summary}`;
      if (row.quote) rowText += `\n  _"${row.quote.slice(0, 150)}"_`;
      if (row.issues?.length > 0) {
        for (const issue of row.issues.slice(0, 3)) {
          rowText += `\n  💡 ${issue}`;
        }
      }
      rowText += '\n';
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: rowText } });
  }

  // Top Fixes
  if (analysis.topFixes?.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🔧 Top Fixes (priority order):*\n${analysis.topFixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}` },
    });
  }

  // Footer
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_Reply in this thread to give feedback and train Brand Guardian._' }],
  });

  // Cap at 49 blocks
  if (blocks.length > 49) blocks.length = 49;

  return blocks;
}

module.exports = { analyzeBrandAlignment, formatResultBlocks, CONTENT_TYPES };
