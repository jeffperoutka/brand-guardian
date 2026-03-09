/**
 * Google Drive + Docs connector
 *
 * Uses a service account to create folders, create docs, read docs, and append content.
 * Service account credentials come from env vars:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY
 *   GOOGLE_DRIVE_PARENT_FOLDER_ID  — the shared "Brand Guardian Clients" folder
 */

const crypto = require('crypto');

// ── JWT / OAuth2 for Service Account ──

function buildJWT(email, privateKey, scopes, impersonateEmail) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    ...(impersonateEmail ? { sub: impersonateEmail } : {}),
  };

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(payload)}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(privateKey, 'base64url');

  return `${unsigned}.${signature}`;
}

let _tokenCache = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenExpiry) return _tokenCache;

  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').trim();

  if (!email || !rawKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY');
  }

  // Vercel env vars encode \n as literal backslash-n — restore them
  const privateKey = rawKey.replace(/\\n/g, '\n');

  // Impersonate a real user so files count against their storage, not the service account's
  const impersonateEmail = (process.env.GOOGLE_IMPERSONATE_EMAIL || '').trim() || null;

  const jwt = buildJWT(email, privateKey, [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
  ], impersonateEmail);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google OAuth failed (${resp.status}): ${err}`);
  }

  const data = await resp.json();
  _tokenCache = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _tokenCache;
}

// ── Drive API ──

/**
 * Create a folder in the parent Brand Guardian folder.
 * Returns { folderId, folderUrl }
 */
async function createFolder(name) {
  const token = await getAccessToken();
  const parentId = (process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || '').trim();

  const resp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive createFolder failed (${resp.status}): ${err}`);
  }

  const file = await resp.json();

  // Set "anyone with link" editor access
  await setPublicAccess(file.id, token);

  return { folderId: file.id, folderUrl: `https://drive.google.com/drive/folders/${file.id}` };
}

/**
 * Create a Google Doc inside a specific folder.
 * Returns { docId, docUrl }
 */
async function createDoc(name, folderId) {
  const token = await getAccessToken();

  const resp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.document',
      ...(folderId ? { parents: [folderId] } : {}),
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive createDoc failed (${resp.status}): ${err}`);
  }

  const file = await resp.json();

  // Set "anyone with link" editor access
  await setPublicAccess(file.id, token);

  return { docId: file.id, docUrl: `https://docs.google.com/document/d/${file.id}/edit` };
}

/**
 * Set "anyone with the link" → Editor permission on a file/folder.
 */
async function setPublicAccess(fileId, token) {
  if (!token) token = await getAccessToken();
  try {
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });
  } catch (err) {
    console.error(`[gdrive] setPublicAccess(${fileId}) failed:`, err.message);
  }
}

// ── Docs API ──

/**
 * Read the full text content of a Google Doc.
 * Returns plain text string.
 */
async function readDoc(docId) {
  const token = await getAccessToken();

  const resp = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Docs readDoc failed (${resp.status}): ${err}`);
  }

  const doc = await resp.json();
  return extractTextFromDoc(doc);
}

/**
 * Write initial content to a Google Doc (form Q&A).
 * Uses batchUpdate with insertText requests.
 */
async function writeDocContent(docId, textContent) {
  const token = await getAccessToken();

  const resp = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: 1 },
          text: textContent,
        },
      }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Docs writeDocContent failed (${resp.status}): ${err}`);
  }

  return resp.json();
}

/**
 * Append research content to the end of a Google Doc.
 */
async function appendToDoc(docId, textContent) {
  const token = await getAccessToken();

  // First, get current doc length
  const docResp = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!docResp.ok) {
    const err = await docResp.text();
    throw new Error(`Docs appendToDoc read failed (${docResp.status}): ${err}`);
  }

  const doc = await docResp.json();
  const body = doc.body;
  const lastElement = body.content[body.content.length - 1];
  const endIndex = lastElement.endIndex - 1; // before the trailing newline

  const resp = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: endIndex },
          text: '\n\n' + textContent,
        },
      }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Docs appendToDoc failed (${resp.status}): ${err}`);
  }

  return resp.json();
}

/**
 * Find a client folder by name inside the parent folder.
 * Returns { folderId, folderUrl } or null.
 */
async function findClientFolder(clientName) {
  const token = await getAccessToken();
  const parentId = (process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || '').trim();

  const q = `mimeType='application/vnd.google-apps.folder' and name contains '${clientName.replace(/'/g, "\\'")}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;

  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.files?.length) return null;

  const folder = data.files[0];
  return { folderId: folder.id, folderUrl: `https://drive.google.com/drive/folders/${folder.id}` };
}

/**
 * Find a Google Doc by name inside a specific folder (or parent folder).
 * Returns { docId, docUrl, docName } or null.
 */
async function findDoc(name, folderId) {
  const token = await getAccessToken();
  const parentId = folderId || (process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || '').trim();

  const q = `mimeType='application/vnd.google-apps.document' and name contains '${name.replace(/'/g, "\\'")}' and trashed=false${parentId ? ` and '${parentId}' in parents` : ''}`;

  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data.files?.length) return null;

  const doc = data.files[0];
  return { docId: doc.id, docUrl: `https://docs.google.com/document/d/${doc.id}/edit`, docName: doc.name };
}

/**
 * List all Google Docs in the parent Brand Guardian folder.
 * Returns array of { name, docId, docName, docUrl }.
 */
async function listClientDocs() {
  const token = await getAccessToken();
  const parentId = (process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || '').trim();

  if (!parentId) {
    console.error('[gdrive] No GOOGLE_DRIVE_PARENT_FOLDER_ID set');
    return [];
  }

  // First list subfolders
  const foldersQ = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const foldersResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(foldersQ)}&fields=files(id,name)&pageSize=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!foldersResp.ok) {
    console.error('[gdrive] listClientDocs folders failed:', foldersResp.status);
    return [];
  }

  const foldersData = await foldersResp.json();
  const results = [];

  // For each client folder, find the "Client Info Doc" inside
  for (const folder of (foldersData.files || [])) {
    const docsQ = `mimeType='application/vnd.google-apps.document' and '${folder.id}' in parents and trashed=false`;
    try {
      const docsResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(docsQ)}&fields=files(id,name)&pageSize=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!docsResp.ok) continue;
      const docsData = await docsResp.json();

      // Find the info doc (or first doc)
      const infoDoc = (docsData.files || []).find(d => /info/i.test(d.name)) || (docsData.files || [])[0];
      if (infoDoc) {
        // Extract client name from folder name (e.g., "Phytoextractum - AEO Labs" → "Phytoextractum")
        const clientName = folder.name.replace(/\s*[-–—]\s*AEO\s*Labs\s*/i, '').trim();
        results.push({
          name: clientName || folder.name,
          docId: infoDoc.id,
          docName: infoDoc.name,
          docUrl: `https://docs.google.com/document/d/${infoDoc.id}/edit`,
          folderId: folder.id,
        });
      }
    } catch (err) {
      console.error(`[gdrive] Error listing docs in folder ${folder.name}:`, err.message);
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ── Helpers ──

/**
 * Extract plain text from a Google Docs API document response.
 */
function extractTextFromDoc(doc) {
  let text = '';
  for (const element of (doc.body?.content || [])) {
    if (element.paragraph) {
      for (const el of (element.paragraph.elements || [])) {
        if (el.textRun) text += el.textRun.content;
      }
    } else if (element.table) {
      for (const row of (element.table.tableRows || [])) {
        for (const cell of (row.tableCells || [])) {
          for (const cellElement of (cell.content || [])) {
            if (cellElement.paragraph) {
              for (const el of (cellElement.paragraph.elements || [])) {
                if (el.textRun) text += el.textRun.content;
              }
            }
          }
          text += '\t';
        }
        text += '\n';
      }
    }
  }
  return text.trim();
}

module.exports = {
  createFolder,
  createDoc,
  readDoc,
  writeDocContent,
  appendToDoc,
  findClientFolder,
  findDoc,
  listClientDocs,
  setPublicAccess,
  getAccessToken,
};
