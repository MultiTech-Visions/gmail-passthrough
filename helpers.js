// Structured logging — visible in Cloud Run's Cloud Logging.

function log(logType, logText) {
  const entry = {
    timestamp: new Date().toISOString(),
    severity: logType === "Error" ? "ERROR" : "INFO",
    type: logType,
    message: logText
  };

  if (logType === "Error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

module.exports = { log };
