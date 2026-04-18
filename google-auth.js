const { google } = require('googleapis');

// ACCOUNTS_CONFIG is a JSON env var keyed by email address.
// Each entry needs: { "refreshToken": "..." }

let accountsConfig = null;
const authClients = {};

function getAccountsConfig() {
  if (accountsConfig) return accountsConfig;
  accountsConfig = JSON.parse(process.env.ACCOUNTS_CONFIG);
  return accountsConfig;
}

function getAccountConfig(emailAddress) {
  const config = getAccountsConfig();
  const accountConf = config[emailAddress.toLowerCase()];
  if (!accountConf) {
    throw new Error(`No configuration found for account: ${emailAddress}. Check your ACCOUNTS_CONFIG env var.`);
  }
  return accountConf;
}

function getAuthClient(emailAddress) {
  if (authClients[emailAddress]) return authClients[emailAddress];

  const accountConf = getAccountConfig(emailAddress);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );

  oauth2Client.setCredentials({
    refresh_token: accountConf.refreshToken
  });

  authClients[emailAddress] = oauth2Client;
  return oauth2Client;
}

function getGmailService(emailAddress) {
  return google.gmail({ version: 'v1', auth: getAuthClient(emailAddress) });
}

module.exports = { getGmailService };
