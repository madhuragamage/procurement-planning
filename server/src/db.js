const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60000,
  dateStrings: true,      // DATE columns as 'YYYY-MM-DD' strings, no timezone shifting
  decimalNumbers: true    // DECIMAL columns as JS numbers
});

module.exports = pool;
