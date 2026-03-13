/**
 * Typeform Webhook → Google Drive + Brand Enrichment Pipeline
 *
 * Flow (split across two serverless invocations for Vercel Hobby 60s limit):
 * Phase 1 (this endpoint): Parse form → Create Drive folder → Create Doc → Write form Q&A
 * Phase 2 (/api/enrich):   Crawl website → Claude analysis → Append research to Doc
 *
 * Zapier config: Typeform "New Entry" → Webhook POST to this endpoint
 * OR direct Typeform webhook → this endpoint
 */

const gdrive = require('./_lib/connectors/gdrive');
const github = require('./_lib/connectors/github');

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

    // Phase 1: Create folder + doc + write form answers (runs within this 60s window)
    const result = await createFolderAndDoc(submission);

    // Phase 2: Fire off enrichment to a separate endpoint (gets its own 60s window)
    const enrichUrl = `https://${req.headers.host}/api/enrich`;
    console.log(`[typeform-webhook] Triggering enrichment at ${enrichUrl}`);
    fetch(enrichUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: submission.clientName,
        websiteUrl: submission.websiteUrl,
        competitors: submission.competitors,
        docId: result.docId,
        folderId: result.folderId,
        docContent: result.docContent,
      }),
    }).catch(err => console.error('[typeform-webhook] Failed to trigger enrichment:', err.message));

    return res.status(200).json({
      ok: true,
      message: `Created folder + doc for ${submission.clientName}. Enrichment running.`,
      docUrl: result.docUrl,
      folderUrl: result.folderUrl,
    });
  } catch (err) {
    console.error('[typeform-webhook] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Phase 1: Create Google Drive folder, doc, write form answers, update index.
 */
async function createFolderAndDoc(submission) {
  const { clientName, websiteUrl, competitors, formAnswers } = submission;
  const folderName = `${clientName} - AEO Labs`;

  // Step 1: Create Google Drive folder
  console.log(`[pipeline] Creating folder: ${folderName}`);
  const folder = await gdrive.createFolder(folderName);
  console.log(`[pipeline] Folder created: ${folder.folderId}`);

  // Step 2: Create the Client Info Doc
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
  console.log(`[pipeline] Index updated`);

  return {
    docId: doc.docId,
    docUrl: doc.docUrl,
    folderId: folder.folderId,
    folderUrl: folder.folderUrl,
    docContent,
  };
}

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
