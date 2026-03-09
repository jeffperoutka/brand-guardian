const { listInfoDocs } = require('./_lib/brand-context');

module.exports = async function handler(req, res) {
  try {
    const results = await listInfoDocs();
    return res.status(200).json({
      count: results.length,
      clients: results.map(r => ({ name: r.name, docId: r.docId, docName: r.docName })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
