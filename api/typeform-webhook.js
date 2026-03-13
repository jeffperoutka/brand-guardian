/**
 * Typeform Webhook → Google Drive + Brand Enrichment Pipeline
 *
 * Flow:
 * 1. Typeform submission hits this endpoint
 * 2. Creates Google Drive folder: "{Client Name} - AEO Labs"
 * 3. Creates Google Doc with all form Q&A inside that folder
 * 4. Triggers brand enrichment (deep research)
 * 5. Appends enrichment results to the same Google Doc
 *
 * Zapier config: Typeform "New Entry" → Webhook POST to this endpoint
 * OR direct Typeform webhook → this endpoint
 */

const { waitUntil } = require('@vercel/functions');
const gdrive = require('./_lib/connectors/gdrive');
const github = require('./_lib/connectors/github');
const { runDeepResearch, hasExistingResearch } = require('./_lib/brand-context');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('[typeform-webhook] Received payload type:', body?.form_response ? 'typeform-direct' : (body?.client_name || body?.website_url) ? 'zapier-formatted' : 'unknown');

    // Parse the submission — supports both direct Typeform webhook and Zapier-formatted payload
    const submission = parseSubmission(body);

    // If no client name but we have a website URL, extract brand name from domain
    if (!submission.clientName && submission.websiteUrl) {
      submission.clientName = await extractBrandNameFromUrl(submission.websiteUrl);
    }

    if (!submission.clientName) {
      return res.status(400).json({ error: 'Missing client name and website URL in submission' });
    }

    console.log(`[typeform-webhook] Client: ${submission.clientName}, Website: ${submission.websiteUrl || 'none'}`);

    // Respond immediately, process in background
    res.status(200).json({
      ok: true,
      message: `Processing ${submission.clientName} — folder + enrichment will be created.`,
    });

    // Run the full pipeline in the background
    waitUntil(runPipeline(submission));
  } catch (err) {
    console.error('[typeform-webhook] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Parse Typeform submission into a normalized format.
 * Supports:
 * - Direct Typeform webhook (form_response.answers + form_response.definition.fields)
 * - Zapier-formatted payload (flat object with client_name, website_url, etc.)
 */
function parseSubmission(body) {
  // Zapier-formatted (flat object)
  if (body.client_name || body.website_url) {
    return {
      clientName: (body.client_name || '').trim(),
      websiteUrl: (body.website_url || body.website || '').trim(),
      competitors: (body.competitors || '').trim(),
      formAnswers: body.answers || body, // pass through all fields
      raw: body,
    };
  }

  // Direct Typeform webhook
  if (body.form_response) {
    const fr = body.form_response;
    const answers = fr.answers || [];
    const fields = fr.definition?.fields || [];

    // Build Q&A pairs
    const qa = [];
    let clientName = '';
    let websiteUrl = '';
    let competitors = '';

    for (const answer of answers) {
      const field = fields.find(f => f.id === answer.field?.id) || {};
      const question = field.title || answer.field?.ref || 'Unknown question';
      const value = extractAnswerValue(answer);

      qa.push({ question, answer: value });

      // Try to identify key fields by common patterns
      const qLower = question.toLowerCase();
      if (!clientName && (qLower.includes('company name') || qLower.includes('brand name') || qLower.includes('client name') || qLower.includes('business name'))) {
        clientName = value;
      }
      if (!websiteUrl && (qLower.includes('website') || qLower.includes('url') || qLower.includes('domain'))) {
        websiteUrl = value;
      }
      if (!competitors && (qLower.includes('competitor') || qLower.includes('competition'))) {
        competitors = value;
      }
    }

    // Fallback: first text answer is likely the client name
    if (!clientName && qa.length > 0) {
      clientName = qa[0].answer;
    }

    return {
      clientName: clientName.trim(),
      websiteUrl: websiteUrl.trim(),
      competitors: competitors.trim(),
      formAnswers: qa,
      raw: body,
    };
  }

  // Unknown format — try to extract what we can
  return {
    clientName: (body.clientName || body.client_name || body.name || '').trim(),
    websiteUrl: (body.websiteUrl || body.website_url || body.website || '').trim(),
    competitors: (body.competitors || '').trim(),
    formAnswers: body,
    raw: body,
  };
}

/**
 * Extract the value from a Typeform answer object.
 */
function extractAnswerValue(answer) {
  switch (answer.type) {
    case 'text': return answer.text || '';
    case 'email': return answer.email || '';
    case 'url': return answer.url || '';
    case 'number': return String(answer.number || '');
    case 'boolean': return answer.boolean ? 'Yes' : 'No';
    case 'choice': return answer.choice?.label || answer.choice?.other || '';
    case 'choices': return (answer.choices?.labels || []).join(', ');
    case 'date': return answer.date || '';
    case 'phone_number': return answer.phone_number || '';
    case 'file_url': return answer.file_url || '';
    default: return JSON.stringify(answer) || '';
  }
}

/**
 * Extract a brand name from a URL using Claude for accurate word splitting.
 * Falls back to simple heuristic if Claude call fails.
 * e.g., "https://kobopickleball.co" → "Kobo Pickleball"
 * e.g., "https://luxunfiltered.com" → "Lux Unfiltered"
 */
async function extractBrandNameFromUrl(url) {
  // Quick domain extraction for the Claude prompt and fallback
  let domain;
  try {
    if (!url.startsWith('http')) url = `https://${url}`;
    let hostname = new URL(url).hostname.replace(/^www\./, '');
    domain = hostname.split('.')[0];
  } catch {
    domain = url.replace(/https?:\/\/(www\.)?/, '').replace(/\.[a-z]+.*$/, '');
  }

  // Ask Claude to extract the brand name (fast, cheap call)
  try {
    const { askClaude } = require('./_lib/connectors/claude');
    const result = await askClaude(
      'Extract the brand/company name from this domain. Return ONLY the properly capitalized brand name, nothing else. Split concatenated words correctly. Examples: "kobopickleball" → "Kobo Pickleball", "luxunfiltered" → "Lux Unfiltered", "unclejimswormfarm" → "Uncle Jims Worm Farm", "enterhealth" → "Enter Health".',
      `Domain: ${domain}`,
      { maxTokens: 50, timeout: 8000, model: 'claude-haiku-4-5-20251001' }
    );
    const name = result.trim().replace(/['"]/g, '');
    if (name && name.length > 0 && name.length < 100) {
      console.log(`[extractBrandName] Claude: "${domain}" → "${name}"`);
      return name;
    }
  } catch (err) {
    console.error('[extractBrandName] Claude fallback failed:', err.message);
  }

  // Simple fallback: hyphens to spaces, title case
  const name = domain.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  console.log(`[extractBrandName] Fallback: "${domain}" → "${name}"`);
  return name;
}

/**
 * Full pipeline: Create folder → Create doc → Enrich → Append results
 */
async function runPipeline(submission) {
  const { clientName, websiteUrl, competitors, formAnswers } = submission;
  const folderName = `${clientName} - AEO Labs`;

  // Vercel Hobby caps background execution at ~55s after response sent.
  // Wrap the entire pipeline in a race against a timeout.
  const PIPELINE_TIMEOUT = 55000;
  const pipelineWork = _runPipelineWork(submission);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Pipeline timeout — Vercel Hobby 60s limit')), PIPELINE_TIMEOUT)
  );

  try {
    await Promise.race([pipelineWork, timeoutPromise]);
  } catch (err) {
    console.error(`[pipeline] ❌ ${clientName}: ${err.message}`);
  }
}

async function _runPipelineWork(submission) {
  const { clientName, websiteUrl, competitors, formAnswers } = submission;
  const folderName = `${clientName} - AEO Labs`;

  try {
    // Step 1: Create Google Drive folder
    console.log(`[pipeline] Creating folder: ${folderName}`);
    const folder = await gdrive.createFolder(folderName);
    console.log(`[pipeline] Folder created: ${folder.folderId}`);

    // Step 2: Create the Client Info Doc with form Q&A
    const docName = `${clientName} Client Info Doc`;
    console.log(`[pipeline] Creating doc: ${docName}`);
    const doc = await gdrive.createDoc(docName, folder.folderId);
    console.log(`[pipeline] Doc created: ${doc.docId}`);

    // Step 3: Write form answers to the doc
    const docContent = formatFormAnswers(clientName, formAnswers, websiteUrl, competitors);
    await gdrive.writeDocContent(doc.docId, docContent);
    console.log(`[pipeline] Form answers written to doc`);

    // Step 4: Update the GitHub info-docs index
    await updateInfoDocsIndex(clientName, doc.docId, docName, folder.folderId);

    // Step 5: Run brand enrichment
    console.log(`[pipeline] Starting brand enrichment for ${clientName}`);
    const research = await runDeepResearch(
      clientName,
      docContent,    // existing doc content (the form answers)
      websiteUrl,
      (msg) => console.log(`[pipeline] ${msg}`),
      { enrichmentNotes: competitors ? `Key competitors: ${competitors}` : '' }
    );

    if (!research) {
      console.error(`[pipeline] Brand enrichment returned null for ${clientName}`);
      await gdrive.appendToDoc(doc.docId, '\n\n---\n\n⚠️ Brand enrichment could not be completed. Please run /brand-enrich in Slack to retry.');
      return;
    }

    // Step 6: Append enrichment results to the doc
    const researchText = formatResearchForDoc(clientName, research);
    await gdrive.appendToDoc(doc.docId, researchText);
    console.log(`[pipeline] Enrichment results appended to doc`);

    // Step 7: Cache the profile in GitHub
    const cacheKey = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const profileWithMeta = {
      ...research,
      clientName,
      cachedAt: new Date().toISOString(),
      cacheKey,
      googleDocId: doc.docId,
      googleFolderId: folder.folderId,
    };
    await github.writeFile(`brand-cache/${cacheKey}.json`, profileWithMeta, `brand-cache: ${clientName}`);

    console.log(`[pipeline] ✅ Complete: ${clientName} — Folder: ${folder.folderUrl}, Doc: ${doc.docUrl}`);
  } catch (err) {
    console.error(`[pipeline] ❌ Failed for ${clientName}:`, err.message, err.stack);
  }
}

/**
 * Format form Q&A as readable text for the Google Doc.
 */
function formatFormAnswers(clientName, formAnswers, websiteUrl, competitors) {
  let text = `${clientName} — Client Info Doc\n\n`;
  text += `Created: ${new Date().toISOString().split('T')[0]}\n`;
  if (websiteUrl) text += `Website: ${websiteUrl}\n`;
  if (competitors) text += `Competitors: ${competitors}\n`;
  text += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  text += 'ONBOARDING FORM RESPONSES\n\n';

  if (Array.isArray(formAnswers)) {
    for (const qa of formAnswers) {
      text += `Q: ${qa.question}\n`;
      text += `A: ${qa.answer || '(no answer)'}\n\n`;
    }
  } else if (typeof formAnswers === 'object') {
    // Zapier flat object — skip internal/duplicate fields
    const skip = new Set(['client_name', 'website_url', 'website', 'competitors', 'raw']);
    let hasAnswers = false;
    for (const [key, value] of Object.entries(formAnswers)) {
      if (skip.has(key) || !value) continue;
      hasAnswers = true;
      // If key looks like a question (long text with spaces/punctuation), use as-is
      // Otherwise convert underscored keys to readable labels
      const label = key.includes(' ') || key.includes('?')
        ? key
        : key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      text += `Q: ${label}\nA: ${value}\n\n`;
    }
    if (!hasAnswers) {
      text += '(No form responses were included in the submission)\n\n';
    }
  }

  return text;
}

/**
 * Format enrichment research results as text for appending to Google Doc.
 */
function formatResearchForDoc(clientName, research) {
  const date = new Date().toISOString().split('T')[0];
  let text = '';

  text += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
  text += '🛡️ BRAND GUARDIAN RESEARCH\n\n';
  text += `Auto-generated on ${date} — updated by Brand Guardian\n`;
  text += 'This section is used for brand alignment checks, content creation, and brand-consistent output.\n\n';

  text += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  text += 'BRAND OVERVIEW\n';
  text += `${research.brandOverview || 'N/A'}\n\n`;

  text += 'TARGET AUDIENCE\n';
  text += `Primary: ${research.targetAudience?.primary || 'Unknown'}\n`;
  text += `Secondary: ${research.targetAudience?.secondary || 'N/A'}\n`;
  text += `Demographics: ${research.targetAudience?.demographics || 'Unknown'}\n`;
  text += `Psychographics: ${research.targetAudience?.psychographics || 'Unknown'}\n\n`;

  text += 'BRAND VOICE & TONE\n';
  text += `Tone: ${research.brandVoice?.tone || 'Unknown'}\n`;
  text += `Personality: ${research.brandVoice?.personality || 'Unknown'}\n`;
  text += `Do Not Say: ${(research.brandVoice?.doNotSay || []).join(', ') || 'None specified'}\n`;
  text += `Preferred Terms: ${(research.brandVoice?.preferredTerms || []).join(', ') || 'None specified'}\n\n`;

  text += 'PRODUCTS & SERVICES\n';
  text += `${(research.coreOfferings?.products || []).map(p => `• ${p}`).join('\n') || 'Not specified'}\n\n`;
  text += `Value Proposition: ${research.coreOfferings?.valueProposition || 'Unknown'}\n`;
  text += `Key Benefits: ${(research.coreOfferings?.keyBenefits || []).join(', ') || 'Unknown'}\n`;
  text += `Pricing Tier: ${research.coreOfferings?.pricingTier || 'Unknown'}\n\n`;

  text += 'COMPETITIVE LANDSCAPE\n';
  text += `${(research.competitors || []).map(c => {
    if (typeof c === 'string') return `• ${c}`;
    return `• ${c.name}: ${c.differentiator || ''}`;
  }).join('\n') || 'No competitors identified'}\n\n`;
  text += `Key Differentiators: ${research.competitiveDifferentiators || 'Not specified'}\n\n`;

  text += 'CONTENT THEMES\n';
  text += `On-Brand Topics: ${(research.contentThemes?.onBrandTopics || []).join(', ') || 'Unknown'}\n`;
  text += `Adjacent Topics (guest posts): ${(research.contentThemes?.adjacentTopics || []).join(', ') || 'Unknown'}\n`;
  text += `Off-Limit Topics: ${(research.contentThemes?.offLimitTopics || []).join(', ') || 'None specified'}\n\n`;

  text += 'KEY MESSAGES\n';
  text += `${(research.keyMessages || []).map(m => `• ${m}`).join('\n') || 'Not specified'}\n\n`;

  text += 'WEBSITE INSIGHTS\n';
  text += `Content Style: ${research.websiteInsights?.contentStyle || 'Unknown'}\n`;
  text += `CTA Patterns: ${research.websiteInsights?.ctaPatterns || 'Unknown'}\n`;
  text += `Social Proof: ${research.websiteInsights?.socialProof || 'Unknown'}\n`;
  text += `Pages Analyzed: ${(research.websiteInsights?.mainPages || []).join(', ') || 'Unknown'}\n\n`;

  text += 'INDUSTRY CONTEXT\n';
  text += `${research.industryContext || 'Not available'}\n`;

  return text;
}

/**
 * Update the GitHub-cached info docs index with the new client.
 */
async function updateInfoDocsIndex(clientName, docId, docName, folderId) {
  try {
    const cached = await github.readFile('brand-cache/info-docs-index.json');
    const docs = cached?.docs || [];

    // Remove existing entry for this client if any
    const filtered = docs.filter(d => d.name.toLowerCase() !== clientName.toLowerCase());

    filtered.push({
      name: clientName,
      docId,
      docName,
      docUrl: `https://docs.google.com/document/d/${docId}/edit`,
      folderId,
      source: 'google-drive',
    });

    filtered.sort((a, b) => a.name.localeCompare(b.name));

    await github.writeFile('brand-cache/info-docs-index.json', {
      docs: filtered,
      updatedAt: new Date().toISOString(),
      count: filtered.length,
    }, `auto: add ${clientName} to info docs index`);

    console.log(`[updateInfoDocsIndex] Added ${clientName} (${docId})`);
  } catch (err) {
    console.error('[updateInfoDocsIndex] Error:', err.message);
  }
}
