module.exports = (req, res) => {
  res.status(200).json({ status: 'ok', bot: 'brand-guardian', timestamp: new Date().toISOString() });
};
