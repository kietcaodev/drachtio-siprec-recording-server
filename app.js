const assert = require('assert');
const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf();

// Custom timestamp
const customTimestamp = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `,"time":"${year}-${month}-${day} ${hours}:${minutes}:${seconds}"`;
};

const logger = srf.locals.logger = pino({
  timestamp: customTimestamp
});

// ✅ FIX 1: Global error handlers - phải thêm trước khi start
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Rejection - preventing crash');
  // Đừng exit, chỉ log để app tiếp tục chạy
});

process.on('uncaughtException', (err) => {
  logger.error(err, 'Uncaught Exception');
  process.exit(1);
});

let callHandler;

if (config.has('drachtio.host')) {
  logger.info(config.get('drachtio'), 'attempting inbound connection');
  srf.connect(config.get('drachtio'));
  srf
    .on('connect', (err, hp) => {
      logger.info(`inbound connection to drachtio listening on ${hp}`);
    })
    .on('error', (err) => {
      logger.error(err, `Error connecting to drachtio server: ${err}`);
    });
} else {
  logger.info(config.get('drachtio'), 'listening for outbound connections');
  srf.listen(config.get('drachtio'));
}

if (config.has('rtpengine')) {
  logger.info(config.get('rtpengine'), 'using rtpengine as the recorder');
  callHandler = require('./lib/rtpengine-call-handler');
  require('./lib/dtmf-event-handler')(logger);
  
  srf.use('invite', (req, res, next) => {
    const ctype = req.get('Content-Type') || '';
    if (!ctype.includes('multipart/mixed')) {
      logger.info(`rejecting non-SIPREC INVITE with call-id ${req.get('Call-ID')}`);
      return res.send(488);
    }
    next();
  });
} else if (config.has('freeswitch')) {
  logger.info(config.get('freeswitch'), 'using freeswitch as the recorder');
  callHandler = require('./lib/freeswitch-call-handler')(logger);
} else {
  assert(false, 'recorder type not specified in configuration: must be either rtpengine or freeswitch');
}

// ✅ FIX 2: Wrap callHandler để catch lỗi SIP responses
srf.invite(async (req, res, next) => {
  try {
    // Wrap callHandler promise để catch lỗi
    const result = callHandler(req, res, next);
    
    // Nếu callHandler trả về promise
    if (result && typeof result.catch === 'function') {
      result.catch((err) => {
        // Nếu là SIP error (487, 408, etc), chỉ log
        if (err.status && err.status >= 400) {
          logger.warn({
            status: err.status,
            reason: err.reason,
            callid: req.get('Call-ID')
          }, 'SIP error from remote party');
        } else {
          logger.error(err, 'Error in call handler');
          res.send(500).catch(e => logger.error(e, 'Error sending 500'));
        }
      });
    }
  } catch (err) {
    logger.error(err, 'Sync error in call handler');
    res.send(500).catch(e => logger.error(e, 'Error sending 500'));
  }
});

// ✅ FIX 3: Handle srf errors
srf.on('error', (err) => {
  logger.error(err, 'SRF error');
});

module.exports = srf;
