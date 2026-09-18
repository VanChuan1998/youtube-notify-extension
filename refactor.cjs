const fs = require('fs');
let code = fs.readFileSync('extension/background.js', 'utf8');

// Replace imports
code = code.replace(/import \{.*?\} from "\.\/lib\/decide\.js";/s, `import {
  findNewVideos,
  rememberSeen,
  classifyVideo,
  shouldOpenTab,
  shouldRecheck,
  isExpired,
  chunkIds,
  hasStreamStarted,
  isWaitingForLive,
} from "./core/domain/Rules.js";
import { StorageAdapter } from "./adapters/StorageAdapter.js";
import { AuthAdapter } from "./adapters/AuthAdapter.js";
import { BadgeNotificationAdapter } from "./adapters/BadgeNotificationAdapter.js";
import { YouTubeAdapter } from "./adapters/YouTubeAdapter.js";
import { OAuthManager } from "./core/usecases/OAuthManager.js";`);

// Replace storage functions
code = code.replace(/getStorage\(/g, "StorageAdapter.getLocal(");
code = code.replace(/setStorage\(/g, "StorageAdapter.setLocal(");
code = code.replace(/removeStorage\(/g, "StorageAdapter.removeLocal(");
code = code.replace(/getSessionStorage\(/g, "StorageAdapter.getSession(");
code = code.replace(/setSessionStorage\(/g, "StorageAdapter.setSession(");
code = code.replace(/removeSessionStorage\(/g, "StorageAdapter.removeSession(");

// Remove the local storage wrappers
code = code.replace(/function getStorage\(keys\) \{[\s\S]*?\}\n/g, "");
code = code.replace(/function setStorage\(items\) \{[\s\S]*?\}\n/g, "");
code = code.replace(/function removeStorage\(keys\) \{[\s\S]*?\}\n/g, "");
code = code.replace(/function getSessionStorage\(keys\) \{[\s\S]*?\}\n/g, "");
code = code.replace(/function setSessionStorage\(items\) \{[\s\S]*?\}\n/g, "");
code = code.replace(/function removeSessionStorage\(keys\) \{[\s\S]*?\}\n/g, "");

// Remove OAuth functions since they are in OAuthManager now
// This is tricky using regex, we might just leave them in background.js for now or replace their calls.
// Actually, let's just use OAuthManager methods.
code = code.replace(/await getCachedOAuthToken/g, "await OAuthManager.getCachedOAuthToken");
code = code.replace(/await restoreOAuthTokenSilently/g, "await OAuthManager.restoreOAuthTokenSilently");
code = code.replace(/await clearOAuthSessionView/g, "await OAuthManager.clearOAuthSessionView");
code = code.replace(/await saveOAuthSession/g, "await OAuthManager.saveOAuthSession");
code = code.replace(/await rememberOAuthAuthorization/g, "await OAuthManager.rememberOAuthAuthorization");
code = code.replace(/await getAuthTokenWebFlow/g, "await OAuthManager.getAuthTokenWebFlow");
code = code.replace(/await getAuthToken\(/g, "await OAuthManager.getAuthToken(");
code = code.replace(/await revokeOAuthGrant/g, "await OAuthManager.revokeOAuthGrant");
code = code.replace(/await clearLocalOAuthState/g, "await OAuthManager.clearLocalOAuthState");
code = code.replace(/await loadOAuthAccountData/g, "await OAuthManager.loadOAuthAccountData");

// Remove the definitions of the old OAuth functions
const funcsToRemove = [
  "rememberOAuthAuthorization", "clearOAuthSessionView", "saveOAuthSession",
  "restoreOAuthTokenSilently", "getCachedOAuthToken", "getAuthToken", 
  "getAuthTokenWebFlow", "revokeOAuthGrant", "clearLocalOAuthState",
  "loadOAuthAccountData"
];

for (const fn of funcsToRemove) {
  // Use a non-greedy regex to remove the function block.
  // Warning: regex for removing functions is brittle. It assumes no nested `function ` definitions at top level.
  const regex1 = new RegExp(`async function ${fn}\\([\\s\\S]*?\\n\\}\\n`, 'g');
  const regex2 = new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}\\n`, 'g');
  code = code.replace(regex1, "");
  code = code.replace(regex2, "");
}

// Write back
fs.writeFileSync('extension/background.js', code);
console.log("Refactored background.js storage and oauth calls.");
