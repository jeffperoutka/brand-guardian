/**
 * Diagnostic endpoint to test Google Drive connection.
 * GET /api/test-gdrive
 */
const gdrive = require('./_lib/connectors/gdrive');

module.exports = async function handler(req, res) {
  const results = { steps: [] };

  // Step 1: Check env vars
  const email = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
  const folderId = (process.env.GOOGLE_DRIVE_PARENT_FOLDER_ID || '').trim();

  results.steps.push({
    step: 'env_vars',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: email ? `${email.slice(0, 20)}...` : 'MISSING',
    GOOGLE_PRIVATE_KEY: key ? `${key.slice(0, 30)}... (${key.length} chars)` : 'MISSING',
    GOOGLE_DRIVE_PARENT_FOLDER_ID: folderId || 'MISSING',
  });

  if (!email || !key || !folderId) {
    results.error = 'Missing env vars';
    return res.status(200).json(results);
  }

  // Step 2: Test auth (get access token)
  try {
    const token = await gdrive.getAccessToken();
    results.steps.push({ step: 'auth', ok: true, tokenPreview: `${token.slice(0, 20)}...` });
  } catch (err) {
    results.steps.push({ step: 'auth', ok: false, error: err.message });
    results.error = 'Auth failed';
    return res.status(200).json(results);
  }

  // Step 3: Test creating a folder
  try {
    const folder = await gdrive.createFolder('_TEST_DELETE_ME');
    results.steps.push({ step: 'create_folder', ok: true, folderId: folder.folderId, folderUrl: folder.folderUrl });

    // Step 4: Test creating a doc inside that folder
    try {
      const doc = await gdrive.createDoc('_TEST_DELETE_ME_Doc', folder.folderId);
      results.steps.push({ step: 'create_doc', ok: true, docId: doc.docId, docUrl: doc.docUrl });

      // Step 5: Test writing to the doc
      try {
        await gdrive.writeDocContent(doc.docId, 'Test content from Brand Guardian diagnostic.');
        results.steps.push({ step: 'write_doc', ok: true });
      } catch (err) {
        results.steps.push({ step: 'write_doc', ok: false, error: err.message });
      }

      // Step 6: Test reading the doc
      try {
        const content = await gdrive.readDoc(doc.docId);
        results.steps.push({ step: 'read_doc', ok: true, contentPreview: content.slice(0, 100) });
      } catch (err) {
        results.steps.push({ step: 'read_doc', ok: false, error: err.message });
      }
    } catch (err) {
      results.steps.push({ step: 'create_doc', ok: false, error: err.message });
    }
  } catch (err) {
    results.steps.push({ step: 'create_folder', ok: false, error: err.message });
  }

  results.allPassed = results.steps.every(s => s.ok !== false);
  return res.status(200).json(results);
};
