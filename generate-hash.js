const bcrypt = require('bcrypt');
const password = 'Machette@33';   // change to your desired password
const hash = bcrypt.hashSync(password, 12);
console.log('Hash:', hash);
console.log('Password:', password);