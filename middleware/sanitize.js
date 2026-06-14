const sanitizeHtml = require('sanitize-html');

exports.sanitizeBody = (fields) => (req, res, next) => {
    for (const field of fields) {
        if (req.body[field]) {
            req.body[field] = sanitizeHtml(req.body[field], {
                allowedTags: [],
                allowedAttributes: {}
            });
        }
    }
    next();
};