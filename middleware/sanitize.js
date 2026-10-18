const sanitizeHtml = require('sanitize-html');

function setDeep(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') return;
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function getDeep(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

exports.sanitizeBody = (fields) => (req, res, next) => {
  for (const field of fields) {
    const current = getDeep(req.body, field);
    if (typeof current === 'string' && current.length > 0) {
      setDeep(req.body, field, sanitizeHtml(current, {
        allowedTags: [],
        allowedAttributes: {}
      }));
    }
  }
  next();
};