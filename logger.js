'use strict';
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize, errors } = format;

const logFormat = printf(({ level, message, timestamp: ts, stack }) => {
  return `${ts} [${level.toUpperCase()}]: ${stack || message}`;
});

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), logFormat),
    }),
    new transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5_242_880, // 5 MB
      maxFiles: 5,
    }),
    new transports.File({
      filename: 'logs/combined.log',
      maxsize: 5_242_880,
      maxFiles: 5,
    }),
  ],
});

module.exports = { logger };
