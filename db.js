require('dotenv').config();
const { Pool } = require('pg');
// load your JSON creds
const creds = require("./game_db_credentials.json");

const pool = new Pool({
    user: creds.user,
    host: creds.host,
    database: creds.database,
    password: creds.password,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});
pool.on('error', (err, client) => {
	 console.log('Unexpected PG error: ' + err);
});
  
module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};
